"""Hosted-mode switches and process-wide cloud backends.

Local mode (MJH_HOSTED unset) never touches these backends. Agent P0 should
read `is_hosted()` rather than inventing a second deployment flag.
"""
from __future__ import annotations

import os

from fastapi import HTTPException


def truthy(name: str) -> bool:
    return os.getenv(name, '').strip().lower() in {'1', 'true', 'yes', 'on'}


def is_hosted() -> bool:
    return truthy('MJH_HOSTED')


def public_origins() -> list[str]:
    return [item.strip() for item in os.getenv('MJH_PUBLIC_ORIGINS', '').split(',') if item.strip()]


def cloud_store():
    from backend.app import app

    store = getattr(app.state, 'cloud', None)
    if store is None:
        store = build_cloud_store()
        app.state.cloud = store
    return store


def object_store():
    from backend.app import app

    store = getattr(app.state, 'objects', None)
    if store is None:
        store = build_object_store()
        app.state.objects = store
    return store


def build_cloud_store():
    if truthy('MJH_ALLOW_MEMORY_STORE'):
        from backend.cloud_store import MemoryCloudStore
        return MemoryCloudStore()
    url = (os.getenv('SUPABASE_DB_URL') or os.getenv('DATABASE_URL') or '').strip()
    if not url:
        raise HTTPException(503, '云端数据库未配置')
    from backend.cloud_store import PostgresCloudStore
    return PostgresCloudStore(url)


def build_object_store():
    supabase_url = os.getenv('SUPABASE_URL', '').strip()
    service_key = os.getenv('SUPABASE_SERVICE_ROLE_KEY', '').strip()
    if supabase_url and service_key and not truthy('MJH_ALLOW_MEMORY_STORE'):
        from backend.objects import SupabaseObjectStore
        return SupabaseObjectStore(
            supabase_url,
            service_key,
            os.getenv('MJH_MEDIA_BUCKET', 'manjinhai-media').strip() or 'manjinhai-media',
        )
    if truthy('MJH_ALLOW_MEMORY_STORE'):
        from backend.objects import MemoryObjectStore
        return MemoryObjectStore()
    raise HTTPException(503, '对象存储未配置')
