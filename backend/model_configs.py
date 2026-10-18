"""Local model configuration storage. Secrets never leave the backend."""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from threading import RLock
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

from fastapi import HTTPException
from pydantic import BaseModel, Field, field_validator, model_validator
from typing import Literal

Kind = Literal['text', 'image', 'video']
Protocol = Literal['chat', 'openai-image', 'agnes-image', 'agnes-video']
# Labels follow https://www.agnes-ai.com/zh-Hans/docs/pricing as of 2026-10-18.
# agnes-video-v2.0 is no longer listed; it stays so saved selections still resolve.
CATALOG: dict[Kind, dict[str, str]] = {
    'text': {
        'agnes-3.0-flash': '当前免费',
        'agnes-2.5-flash': '当前免费',
        'agnes-2.5-pro': '付费',
        'agnes-2.5-pro-beta': '付费',
        'agnes-3.0-pro': '即将上线 · 付费',
    },
    'image': {
        'agnes-image-2.5-flash': '当前免费',
        'agnes-image-2.1-flash': '当前免费',
        'agnes-image-2.0-flash': '当前免费',
    },
    'video': {
        'agnes-video-2.5-flash': '限时免费',
        'agnes-video-2.5': '付费',
        'agnes-video-v2.0': '已下架',
    },
}
DEFAULT_URL = 'https://apihub.agnes-ai.com/v1'


def normalize_url(value: str) -> str:
    value = value.strip().rstrip('/')
    parsed = urlsplit(value)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('请输入不含账号、查询参数的 HTTP(S) API 地址')
    for suffix in ('/chat/completions', '/images/generations', '/images/edits', '/videos'):
        if value.endswith(suffix):
            value = value[:-len(suffix)]
            break
    if not urlsplit(value).path:
        value += '/v1'
    return value


class ConnectionInput(BaseModel):
    base_url: str = Field(max_length=2000)
    api_key: str = Field(default='', repr=False)

    @field_validator('base_url')
    @classmethod
    def valid_url(cls, value: str) -> str:
        return normalize_url(value)


class ConfigInput(ConnectionInput):
    name: str = Field(min_length=1, max_length=100)
    kind: Kind
    protocol: Protocol
    model: str = Field(min_length=1, max_length=120)

    @field_validator('name', 'model')
    @classmethod
    def nonempty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError('不能为空')
        return value.strip()

    @model_validator(mode='after')
    def compatible(self):
        allowed = {'text': ['chat'], 'image': ['openai-image', 'agnes-image'], 'video': ['agnes-video']}
        if self.protocol not in allowed[self.kind]:
            raise ValueError('模型类型与接口类型不匹配')
        return self


class ConfigStore:
    def __init__(self, path: Path, settings):
        self.path, self.settings = path, settings
        self.lock = RLock()

    def read(self):
        if not self.path.exists():
            return {'configs': [], 'agnes': None}
        try:
            data = json.loads(self.path.read_text())
            if not isinstance(data, dict) or not isinstance(data.get('configs'), list):
                raise ValueError()
            return data
        except (ValueError, OSError):
            raise HTTPException(503, '模型配置文件无法读取，请检查本机文件；未覆盖原配置')

    def write(self, data):
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, temp = tempfile.mkstemp(dir=self.path.parent, prefix='.models-')
        try:
            with os.fdopen(fd, 'w') as stream:
                json.dump(data, stream, ensure_ascii=False, indent=2)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp, self.path)
        finally:
            if os.path.exists(temp):
                os.unlink(temp)

    def all(self):
        with self.lock:
            data = self.read()
            s = self.settings
            groups = {
                'text': (s.models, s.base_url, s.api_key, 'chat'),
                'image': (s.image_models, s.image_base_url, s.image_api_key, f'{s.image_provider}-image'),
                'video': (s.video_models, s.video_base_url, s.video_api_key, 'agnes-video'),
            }
            result = []
            for kind, (models, url, key, protocol) in groups.items():
                for model in dict.fromkeys([*models, *CATALOG[kind]]):
                    is_agnes = model.startswith('agnes-')
                    connection = data.get('agnes') if is_agnes else None
                    entry = {
                        'id': f'builtin:{kind}:{model}', 'name': model, 'model': model,
                        'kind': kind, 'protocol': ('chat' if kind == 'text' else f'agnes-{kind}') if is_agnes else protocol,
                        'base_url': connection['base_url'] if connection else (url if model in models else DEFAULT_URL),
                        'api_key': connection['api_key'] if connection else (key if model in models or 'agnes-ai.' in url else ''),
                        'builtin': True,
                        'pricing': CATALOG[kind].get(model, ''),
                    }
                    if kind == 'video':
                        parsed = urlsplit(entry['base_url'])
                        entry['query_base_url'] = urlunsplit((parsed.scheme, parsed.netloc, '', '', '')) if connection or model not in models else s.video_query_base_url
                    result.append(entry)
            return result + data['configs']

    @staticmethod
    def public(entry):
        return {**{k: v for k, v in entry.items() if k not in ('api_key', 'query_base_url')}, 'configured': bool(entry['api_key'])}

    def get(self, config_id, kind=None):
        entry = next((c for c in self.all() if c['id'] == config_id), None)
        if entry is None:
            raise HTTPException(404, '模型配置已不存在，请重新选择模型')
        if kind and entry['kind'] != kind:
            raise HTTPException(422, '模型配置类型不匹配')
        return dict(entry)

    def save(self, value: ConfigInput, config_id=None):
        with self.lock:
            data = self.read()
            previous = next((c for c in data['configs'] if c['id'] == config_id), None)
            if config_id and previous is None:
                raise HTTPException(404, '自定义模型不存在')
            entry = value.model_dump()
            entry.update(id=config_id or f'custom:{uuid4().hex}', builtin=False, pricing='')
            entry['api_key'] = value.api_key.strip() or (previous['api_key'] if previous else '')
            if not entry['api_key']:
                raise HTTPException(422, '请填写 API Key')
            data['configs'] = [c for c in data['configs'] if c['id'] != config_id] + [entry]
            self.write(data)
            return self.public(entry)

    def delete(self, config_id):
        with self.lock:
            data = self.read()
            if not any(c['id'] == config_id for c in data['configs']):
                raise HTTPException(404, '自定义模型不存在')
            data['configs'] = [c for c in data['configs'] if c['id'] != config_id]
            self.write(data)

    def connection(self):
        data = self.read().get('agnes')
        if data:
            return data
        s = self.settings
        return {'base_url': s.base_url if 'agnes-ai.' in s.base_url else DEFAULT_URL,
                'api_key': s.api_key if 'agnes-ai.' in s.base_url else ''}

    def save_connection(self, value: ConnectionInput):
        with self.lock:
            data = self.read()
            data['agnes'] = {'base_url': value.base_url, 'api_key': value.api_key.strip() or self.connection()['api_key']}
            if not data['agnes']['api_key']:
                raise HTTPException(422, '请填写 Agnes API Key')
            self.write(data)
