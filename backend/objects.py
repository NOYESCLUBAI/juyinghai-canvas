"""Private media objects. Keys are `{user_id}/{asset_id}` and URLs are short-lived."""
from __future__ import annotations

import hashlib
import hmac
import os
import time
from dataclasses import dataclass

import httpx
from fastapi import HTTPException


def signing_secret() -> bytes:
    raw = os.getenv('MJH_MEDIA_SIGNING_KEY', '').strip() or os.getenv('MJH_CONFIG_ENCRYPTION_KEY', '').strip()
    if not raw:
        raise HTTPException(503, '对象签名密钥未配置')
    return raw.encode('utf-8')


def signed_url_ttl() -> int:
    try:
        ttl = int(os.getenv('MJH_SIGNED_URL_SECONDS', '120'))
    except ValueError:
        ttl = 120
    return min(max(ttl, 30), 3600)


def max_media_bytes() -> int:
    try:
        size = int(os.getenv('MJH_MEDIA_MAX_BYTES', str(45 * 1024 * 1024)))
    except ValueError:
        size = 45 * 1024 * 1024
    return max(size, 1)


@dataclass
class StoredObject:
    user_id: str
    asset_id: str
    data: bytes
    content_type: str
    file_name: str


class MemoryObjectStore:
    def __init__(self) -> None:
        self._items: dict[tuple[str, str], StoredObject] = {}

    async def put(self, user_id: str, asset_id: str, data: bytes, content_type: str, file_name: str) -> None:
        if len(data) > max_media_bytes():
            raise HTTPException(413, '素材超过当前大小限制')
        self._items[(user_id, asset_id)] = StoredObject(user_id, asset_id, data, content_type, file_name)

    async def get(self, user_id: str, asset_id: str) -> StoredObject | None:
        return self._items.get((user_id, asset_id))

    async def delete(self, user_id: str, asset_id: str) -> None:
        self._items.pop((user_id, asset_id), None)

    async def signed_url(self, user_id: str, asset_id: str) -> str:
        if (user_id, asset_id) not in self._items:
            raise HTTPException(404, '素材不存在')
        exp = int(time.time()) + signed_url_ttl()
        signature = hmac.new(signing_secret(), f'{user_id}/{asset_id}/{exp}'.encode(), hashlib.sha256).hexdigest()
        return f'/api/media/{asset_id}/content?uid={user_id}&exp={exp}&sig={signature}'


def verify_media_signature(user_id: str, asset_id: str, exp: str, signature: str) -> None:
    try:
        expires = int(exp)
    except (TypeError, ValueError) as exc:
        raise HTTPException(403, '素材链接无效') from exc
    now = int(time.time())
    if expires < now or expires > now + 3600:
        raise HTTPException(403, '素材链接已失效')
    expected = hmac.new(signing_secret(), f'{user_id}/{asset_id}/{expires}'.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature or ''):
        raise HTTPException(403, '素材链接无效')


class SupabaseObjectStore:
    def __init__(self, supabase_url: str, service_key: str, bucket: str) -> None:
        self.url = supabase_url.rstrip('/')
        self.service_key = service_key
        self.bucket = bucket

    def _headers(self, content_type: str | None = None) -> dict[str, str]:
        headers = {
            'Authorization': f'Bearer {self.service_key}',
            'apikey': self.service_key,
        }
        if content_type:
            headers['Content-Type'] = content_type
        return headers

    def _path(self, user_id: str, asset_id: str) -> str:
        return f'{user_id}/{asset_id}'

    async def put(self, user_id: str, asset_id: str, data: bytes, content_type: str, file_name: str) -> None:
        del file_name
        if len(data) > max_media_bytes():
            raise HTTPException(413, '素材超过当前大小限制')
        path = self._path(user_id, asset_id)
        async with httpx.AsyncClient(timeout=httpx.Timeout(60, connect=10)) as client:
            response = await client.post(
                f'{self.url}/storage/v1/object/{self.bucket}/{path}',
                headers={**self._headers(content_type), 'x-upsert': 'true'},
                content=data,
            )
        if response.is_error:
            raise HTTPException(502, '素材写入对象存储失败')

    async def get(self, user_id: str, asset_id: str) -> StoredObject | None:
        path = self._path(user_id, asset_id)
        async with httpx.AsyncClient(timeout=httpx.Timeout(60, connect=10)) as client:
            response = await client.get(
                f'{self.url}/storage/v1/object/{self.bucket}/{path}',
                headers=self._headers(),
            )
        if response.status_code == 404:
            return None
        if response.is_error:
            raise HTTPException(502, '素材读取失败')
        media_type = response.headers.get('content-type', 'application/octet-stream').split(';', 1)[0]
        return StoredObject(user_id, asset_id, response.content, media_type, asset_id)

    async def delete(self, user_id: str, asset_id: str) -> None:
        path = self._path(user_id, asset_id)
        async with httpx.AsyncClient(timeout=httpx.Timeout(30, connect=10)) as client:
            response = await client.delete(
                f'{self.url}/storage/v1/object/{self.bucket}',
                headers={**self._headers('application/json')},
                json={'prefixes': [path]},
            )
        if response.is_error and response.status_code != 404:
            raise HTTPException(502, '素材删除失败')

    async def signed_url(self, user_id: str, asset_id: str) -> str:
        path = self._path(user_id, asset_id)
        async with httpx.AsyncClient(timeout=httpx.Timeout(15, connect=10)) as client:
            response = await client.post(
                f'{self.url}/storage/v1/object/sign/{self.bucket}/{path}',
                headers=self._headers('application/json'),
                json={'expiresIn': signed_url_ttl()},
            )
        if response.is_error:
            raise HTTPException(404, '素材不存在')
        try:
            signed = response.json().get('signedURL') or response.json().get('signedUrl')
        except ValueError as exc:
            raise HTTPException(502, '素材链接签发失败') from exc
        if not isinstance(signed, str) or not signed:
            raise HTTPException(502, '素材链接签发失败')
        if signed.startswith('http://') or signed.startswith('https://'):
            return signed
        return f'{self.url}/storage/v1{signed}'
