"""Background video jobs. A restart continues from the stored upstream video_id."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from backend.crypto_box import KeyBox
from backend.video_protocol import TemporaryUpstream, create_agnes_video, download_agnes_video, poll_agnes_video, result_video_url

log = logging.getLogger('backend.video')


def new_job(*, user_id: str, entry: dict, prompt: str, aspect_ratio: str, duration: int, timeout_seconds: float) -> dict:
    now = datetime.now(timezone.utc)
    box = KeyBox.from_env()
    return {
        'id': uuid4().hex,
        'user_id': user_id,
        'status': 'queued',
        'model_config_id': entry['id'],
        'model': entry['model'],
        'base_url': entry['base_url'],
        'query_base_url': entry.get('query_base_url') or '',
        'api_key_ciphertext': box.encrypt(entry['api_key']),
        'prompt': prompt,
        'aspect_ratio': aspect_ratio,
        'duration': duration,
        'upstream_video_id': None,
        'error': None,
        'result_asset_id': None,
        'result_content_type': None,
        'seconds': None,
        'size': None,
        'created_at': now.isoformat(),
        'updated_at': now.isoformat(),
        'deadline_at': (now + timedelta(seconds=timeout_seconds)).isoformat(),
    }


def _safe_error(exc) -> str:
    from backend.app import safe_provider_error
    return safe_provider_error(exc)


async def advance_job(job: dict, client, objects) -> dict:
    """One step. Creating a task and polling it happen on different steps so the id is stored first."""
    from backend.app import ProviderError

    job = dict(job)
    if job['status'] in {'completed', 'failed', 'cancelled'}:
        return job
    now = datetime.now(timezone.utc)
    if now >= datetime.fromisoformat(job['deadline_at']):
        job['status'] = 'failed'
        job['error'] = '视频生成等待超时，请稍后重试'
        job['updated_at'] = now.isoformat()
        return job
    try:
        api_key = KeyBox.from_env().decrypt(job['api_key_ciphertext'])
    except Exception:
        job['status'] = 'failed'
        job['error'] = '无法读取模型密钥，请重新保存配置'
        job['updated_at'] = now.isoformat()
        return job
    try:
        if not job.get('upstream_video_id'):
            video_id = await create_agnes_video(
                client,
                base_url=job['base_url'],
                api_key=api_key,
                model=job['model'],
                prompt=job['prompt'],
                aspect_ratio=job['aspect_ratio'],
                duration=int(job['duration']),
            )
            job['upstream_video_id'] = video_id
            job['status'] = 'running'
            job['updated_at'] = datetime.now(timezone.utc).isoformat()
            return job
        result = await poll_agnes_video(
            client,
            query_base_url=job['query_base_url'],
            api_key=api_key,
            model=job['model'],
            video_id=job['upstream_video_id'],
        )
        if result is None:
            job['status'] = 'running'
            job['updated_at'] = datetime.now(timezone.utc).isoformat()
            return job
        content, media_type = await download_agnes_video(client, result_video_url(result))
    except TemporaryUpstream:
        return job
    except ProviderError as exc:
        job['status'] = 'failed'
        job['error'] = _safe_error(exc)
        job['updated_at'] = datetime.now(timezone.utc).isoformat()
        return job
    asset_id = job.get('result_asset_id') or uuid4().hex
    await objects.put(job['user_id'], asset_id, content, media_type, 'manjinhai-video.mp4')
    job['result_asset_id'] = asset_id
    job['result_content_type'] = media_type
    job['seconds'] = str(result.get('seconds') or job['duration'])
    job['size'] = str(result.get('size') or '')
    job['status'] = 'completed'
    job['updated_at'] = datetime.now(timezone.utc).isoformat()
    return job


async def tick_open_jobs(store, objects, client) -> None:
    for job in store.list_jobs_by_status(('queued', 'running')):
        fresh = store.get_job(job['user_id'], job['id'])
        if fresh is None or fresh['status'] == 'cancelled':
            continue
        try:
            updated = await advance_job(fresh, client, objects)
        except Exception:
            log.warning('video job %s step failed', job.get('id'))
            continue
        store.save_job(updated)


async def video_worker(app, stop) -> None:
    import asyncio
    import os

    from backend.runtime import cloud_store, object_store

    interval = float(os.getenv('MJH_VIDEO_POLL_SECONDS', '3'))
    while not stop.is_set():
        try:
            await tick_open_jobs(cloud_store(), object_store(), app.state.http_client)
        except Exception:
            log.warning('video worker iteration failed')
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval)
        except asyncio.TimeoutError:
            continue
