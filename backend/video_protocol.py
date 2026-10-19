"""Agnes video HTTP steps shared by the local request and the hosted worker.

One poll does not sleep. The caller decides whether to wait or persist and resume.
"""
from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit, urlunsplit

import httpx

AGNES_VIDEO_25_MODELS = frozenset({'agnes-video-2.5', 'agnes-video-2.5-flash'})


class TemporaryUpstream(Exception):
    """Poll or download can be retried without creating another upstream task."""


def video_size(aspect_ratio: str) -> tuple[int, int]:
    sizes = {
        'adaptive': (1152, 768),
        '1:1': (720, 720),
        '16:9': (1280, 720),
        '9:16': (720, 1280),
        '4:3': (960, 720),
        '3:4': (720, 960),
    }
    return sizes[aspect_ratio]


def query_base_from_url(base_url: str) -> str:
    parsed = urlsplit(base_url)
    return urlunsplit((parsed.scheme, parsed.netloc, '', '', ''))


def _errors():
    from backend.app import ProviderError, provider_error_message
    return ProviderError, provider_error_message


def create_payload(model: str, prompt: str, aspect_ratio: str, duration: int) -> dict[str, Any]:
    if model in AGNES_VIDEO_25_MODELS:
        return {
            'model': model,
            'prompt': prompt,
            'seconds': str(duration),
            'mode': 'text',
            'size': '720P',
            'aspect_ratio': '16:9' if aspect_ratio == 'adaptive' else aspect_ratio,
        }
    width, height = video_size(aspect_ratio)
    return {
        'model': model,
        'prompt': prompt,
        'width': width,
        'height': height,
        'num_frames': duration * 24 + 1,
        'frame_rate': 24,
    }


async def create_agnes_video(
    client: httpx.AsyncClient,
    *,
    base_url: str,
    api_key: str,
    model: str,
    prompt: str,
    aspect_ratio: str,
    duration: int,
) -> str:
    ProviderError, provider_error_message = _errors()
    try:
        response = await client.post(
            f'{base_url.rstrip("/")}/videos',
            headers={'Authorization': f'Bearer {api_key}', 'Content-Type': 'application/json'},
            json=create_payload(model, prompt, aspect_ratio, duration),
            timeout=httpx.Timeout(60, connect=15),
        )
    except httpx.TimeoutException as exc:
        raise ProviderError(504, '创建视频任务超时，请稍后重试') from exc
    except httpx.HTTPError as exc:
        raise ProviderError(502, '无法连接 Agnes AI 视频服务') from exc
    if response.is_error:
        raise ProviderError(response.status_code, provider_error_message(response))
    try:
        task = response.json()
    except ValueError as exc:
        raise ProviderError(502, '视频模型返回了无效任务数据') from exc
    video_id = task.get('video_id') if isinstance(task, dict) else None
    if not isinstance(video_id, str) or not video_id:
        raise ProviderError(502, '视频模型没有返回 video_id')
    return video_id


async def poll_agnes_video(
    client: httpx.AsyncClient,
    *,
    query_base_url: str,
    api_key: str,
    model: str,
    video_id: str,
) -> dict[str, Any] | None:
    """Return the completed payload, None while the task is still running."""
    ProviderError, provider_error_message = _errors()
    try:
        response = await client.get(
            f'{query_base_url.rstrip("/")}/agnesapi',
            headers={'Authorization': f'Bearer {api_key}'},
            params={'video_id': video_id, 'model_name': model},
            timeout=httpx.Timeout(30, connect=15),
        )
    except httpx.TimeoutException as exc:
        raise TemporaryUpstream() from exc
    except httpx.HTTPError as exc:
        raise ProviderError(502, '无法查询 Agnes AI 视频任务') from exc
    if response.is_error:
        if response.status_code in {429, 500, 502, 503}:
            raise TemporaryUpstream()
        raise ProviderError(response.status_code, provider_error_message(response))
    try:
        payload = response.json()
    except ValueError as exc:
        raise ProviderError(502, '视频模型返回了无效状态数据') from exc
    if not isinstance(payload, dict):
        raise ProviderError(502, '视频模型返回了无效状态数据')
    status = str(payload.get('status') or '').lower()
    if status == 'completed':
        return payload
    if status == 'failed':
        error = payload.get('error')
        message = str(error.get('message') or error) if isinstance(error, dict) else str(error or '视频生成失败')
        raise ProviderError(502, message[:500])
    return None


def result_video_url(result: dict[str, Any]) -> str:
    ProviderError, _message = _errors()
    video_url = result.get('url')
    if not isinstance(video_url, str) or not video_url.startswith(('http://', 'https://')):
        metadata = result.get('metadata')
        video_url = metadata.get('url') if isinstance(metadata, dict) else None
    if not isinstance(video_url, str) or not video_url.startswith(('http://', 'https://')):
        raise ProviderError(502, '视频模型没有返回可用视频')
    return video_url


async def download_agnes_video(client: httpx.AsyncClient, video_url: str) -> tuple[bytes, str]:
    ProviderError, _message = _errors()
    try:
        response = await client.get(video_url, timeout=httpx.Timeout(120, connect=15))
    except httpx.TimeoutException as exc:
        raise TemporaryUpstream() from exc
    except httpx.HTTPError as exc:
        raise ProviderError(502, '无法下载视频模型的生成结果') from exc
    if response.is_error:
        if response.status_code in {429, 500, 502, 503}:
            raise TemporaryUpstream()
        raise ProviderError(502, '无法下载视频模型的生成结果')
    media_type = response.headers.get('content-type', 'video/mp4').split(';', 1)[0]
    if not media_type.startswith('video/'):
        raise ProviderError(502, '视频模型返回的结果不是视频')
    return response.content, media_type
