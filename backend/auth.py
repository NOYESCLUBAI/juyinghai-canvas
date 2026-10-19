"""Supabase JWT verification and the shared `current_user` dependency.

Hosted mode accepts either the project JWT secret (HS256) or a JWKS document
(RS256 / ES256). Configure one or both; the token header selects the algorithm.

Agent P0's OpenAI-compatible proxy should depend on `current_user` and must
not trust a user id sent in the body.
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass

import httpx
import jwt
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from jwt.algorithms import ECAlgorithm, RSAAlgorithm

from backend.rate_limit import LIMITER, limit_for
from backend.runtime import is_hosted


@dataclass(frozen=True)
class AuthUser:
    id: str
    email: str | None = None


_jwks_cache: dict[str, object] = {'keys': None, 'fetched_at': 0.0}
_jwks_override: dict | None = None

GENERATION_PATHS = {
    '/api/chat': 'text',
    '/api/images/generate': 'image',
    '/api/videos/generate': 'video',
}


def set_jwks_override(document: dict | None) -> None:
    global _jwks_override
    _jwks_override = document
    _jwks_cache['keys'] = None
    _jwks_cache['fetched_at'] = 0.0


def reset_auth_state() -> None:
    set_jwks_override(None)


def _audience() -> str:
    return os.getenv('SUPABASE_JWT_AUD', 'authenticated').strip() or 'authenticated'


def _jwks_url() -> str:
    explicit = os.getenv('SUPABASE_JWKS_URL', '').strip()
    if explicit:
        return explicit
    base = os.getenv('SUPABASE_URL', '').strip().rstrip('/')
    if not base:
        return ''
    return f'{base}/auth/v1/.well-known/jwks.json'


def _load_jwks() -> dict:
    if _jwks_override is not None:
        return _jwks_override
    now = time.monotonic()
    cached = _jwks_cache.get('keys')
    if isinstance(cached, dict) and now - float(_jwks_cache['fetched_at']) < 600:
        return cached
    url = _jwks_url()
    if not url:
        raise HTTPException(401, '登录已失效，请重新登录')
    try:
        response = httpx.get(url, timeout=5)
        response.raise_for_status()
        document = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(401, '登录已失效，请重新登录') from exc
    if not isinstance(document, dict) or not isinstance(document.get('keys'), list):
        raise HTTPException(401, '登录已失效，请重新登录')
    _jwks_cache['keys'] = document
    _jwks_cache['fetched_at'] = now
    return document


def _key_for_token(token: str):
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError as exc:
        raise HTTPException(401, '登录已失效，请重新登录') from exc
    algorithm = header.get('alg')
    if algorithm == 'HS256':
        secret = os.getenv('SUPABASE_JWT_SECRET', '').strip()
        if not secret:
            raise HTTPException(401, '登录已失效，请重新登录')
        return secret, 'HS256'
    if algorithm not in {'RS256', 'ES256'}:
        raise HTTPException(401, '登录已失效，请重新登录')
    kid = header.get('kid')
    document = _load_jwks()
    matches = [item for item in document['keys'] if not kid or item.get('kid') == kid]
    if not matches:
        raise HTTPException(401, '登录已失效，请重新登录')
    jwk = json.dumps(matches[0])
    try:
        key = RSAAlgorithm.from_jwk(jwk) if algorithm == 'RS256' else ECAlgorithm.from_jwk(jwk)
    except Exception as exc:
        raise HTTPException(401, '登录已失效，请重新登录') from exc
    return key, algorithm


def verify_supabase_jwt(token: str) -> AuthUser:
    key, algorithm = _key_for_token(token)
    options = {'require': ['exp', 'sub']}
    kwargs = {'algorithms': [algorithm], 'audience': _audience(), 'leeway': 30, 'options': options}
    issuer = os.getenv('SUPABASE_JWT_ISS', '').strip()
    if issuer:
        kwargs['issuer'] = issuer
    try:
        payload = jwt.decode(token, key, **kwargs)
    except jwt.PyJWTError as exc:
        raise HTTPException(401, '登录已失效，请重新登录') from exc
    subject = str(payload.get('sub') or '').strip()
    if not subject:
        raise HTTPException(401, '登录已失效，请重新登录')
    email = payload.get('email')
    return AuthUser(subject, email.strip().lower() if isinstance(email, str) and email.strip() else None)


def _bearer(request: Request) -> str:
    header = request.headers.get('authorization', '')
    scheme, _, token = header.partition(' ')
    if scheme.lower() != 'bearer' or not token.strip():
        raise HTTPException(401, '请先登录')
    return token.strip()


def assert_invited(user: AuthUser) -> None:
    entries = {item.strip().lower() for item in os.getenv('MJH_INVITE_ALLOWLIST', '').split(',') if item.strip()}
    if user.email and user.email in entries:
        return
    if user.id.lower() in entries:
        return
    from backend.runtime import cloud_store
    try:
        allowed = cloud_store().invite_contains(user.email or '')
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(503, '邀请名单暂时无法读取') from exc
    if allowed:
        return
    raise HTTPException(403, '当前账号不在邀请名单中')


def authenticate(request: Request) -> AuthUser:
    user = verify_supabase_jwt(_bearer(request))
    assert_invited(user)
    return user


async def current_user(request: Request) -> AuthUser | None:
    """Shared dependency. Local mode returns None. Hosted mode requires an allowlisted user."""
    if not is_hosted():
        return None
    existing = getattr(request.state, 'user', None)
    if isinstance(existing, AuthUser):
        return existing
    user = authenticate(request)
    request.state.user = user
    return user


def client_ip(request: Request) -> str:
    if is_hosted():
        forwarded = request.headers.get('x-forwarded-for', '')
        if forwarded:
            return forwarded.split(',')[0].strip()[:80] or 'unknown'
    if request.client and request.client.host:
        return request.client.host
    return 'unknown'


def _open_path(path: str, method: str) -> bool:
    if method == 'OPTIONS':
        return True
    if path in {'/livez', '/api/health'}:
        return True
    return path.startswith('/api/media/') and path.endswith('/content')


async def hosted_guard(request: Request, call_next):
    if not is_hosted() or _open_path(request.url.path, request.method):
        return await call_next(request)
    if not request.url.path.startswith('/api/'):
        return await call_next(request)
    try:
        user = authenticate(request)
        request.state.user = user
        kind = GENERATION_PATHS.get(request.url.path)
        if request.method == 'POST' and kind:
            LIMITER.hit(user.id, client_ip(request), kind, limit=limit_for(kind))
    except HTTPException as exc:
        detail = exc.detail if isinstance(exc.detail, str) else '请求被拒绝'
        response = JSONResponse(status_code=exc.status_code, content={'detail': detail})
        origin = request.headers.get('origin')
        from backend.runtime import public_origins
        local = [f'http://{host}:{port}' for host in ('127.0.0.1', 'localhost') for port in {'5173', os.getenv('MJH_WEB_PORT', '5173')}]
        if origin and origin in {*local, *public_origins()}:
            response.headers['Access-Control-Allow-Origin'] = origin
            response.headers['Access-Control-Allow-Credentials'] = 'true'
            response.headers['Vary'] = 'Origin'
        return response
    return await call_next(request)
