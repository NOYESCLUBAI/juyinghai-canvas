"""Hosted project, media, video-job and agent-session routes.

These routes are inert unless MJH_HOSTED is on. Local mode keeps using
localStorage and IndexedDB and never calls them.
"""
from __future__ import annotations

import base64
import binascii
from datetime import datetime, timezone
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from backend.objects import max_media_bytes, verify_media_signature
from backend.runtime import cloud_store, is_hosted, object_store

router = APIRouter()


def _hosted() -> None:
    if not is_hosted():
        raise HTTPException(404, '未找到')


def _user(request: Request):
    user = getattr(request.state, 'user', None)
    if user is None:
        raise HTTPException(401, '请先登录')
    return user


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class ProjectAssetIn(BaseModel):
    projectId: str = Field(min_length=1, max_length=80)
    assetId: str = Field(min_length=1, max_length=80)
    kind: Literal['image', 'video']
    fileName: str = Field(min_length=1, max_length=300)
    createdAt: str = Field(min_length=1, max_length=80)


class GlobalAssetIn(ProjectAssetIn):
    savedAt: str = Field(min_length=1, max_length=80)


class SessionIn(BaseModel):
    projectId: str = Field(min_length=1, max_length=80)
    canvasId: str = Field(min_length=1, max_length=80)
    messages: list = Field(default_factory=list)


def decode_data_url(data_url: str) -> tuple[bytes, str]:
    try:
        header, encoded = data_url.split(',', 1)
    except ValueError as exc:
        raise HTTPException(502, '图片结果无法保存') from exc
    if not header.startswith('data:') or ';base64' not in header:
        raise HTTPException(502, '图片结果无法保存')
    media_type = header[5:].split(';', 1)[0] or 'image/png'
    try:
        return base64.b64decode(encoded, validate=True), media_type
    except (ValueError, binascii.Error) as exc:
        raise HTTPException(502, '图片结果无法保存') from exc


async def store_data_url(user_id: str, data_url: str, file_name: str) -> tuple[str, str]:
    data, media_type = decode_data_url(data_url)
    asset_id = str(uuid4())
    await object_store().put(user_id, asset_id, data, media_type, file_name)
    url = await object_store().signed_url(user_id, asset_id)
    return asset_id, url


def public_job(job: dict, url: str | None = None) -> dict:
    completed = job['status'] == 'completed'
    return {
        'job_id': job['id'],
        'status': job['status'],
        'error': job.get('error'),
        'asset_id': job.get('result_asset_id') if completed else None,
        'url': url if completed else None,
        'content_type': job.get('result_content_type') if completed else None,
        'model': job.get('model'),
        'seconds': job.get('seconds'),
        'size': job.get('size'),
        'notice': '已停止等待。已提交到上游的视频可能仍会计费。' if job['status'] == 'cancelled' else None,
    }


@router.get('/api/library')
async def get_library(request: Request):
    _hosted()
    return cloud_store().read_library(_user(request).id)


@router.put('/api/library')
async def put_library(request: Request):
    _hosted()
    user = _user(request)
    try:
        payload = await request.json()
    except Exception as exc:
        raise HTTPException(422, '项目列表格式无效') from exc
    return cloud_store().replace_library(user.id, payload)


@router.post('/api/media')
async def upload_media(
    request: Request,
    file: UploadFile = File(...),
    project_id: str | None = Form(default=None),
):
    _hosted()
    user = _user(request)
    data = await file.read()
    if len(data) > max_media_bytes():
        raise HTTPException(413, '素材超过当前大小限制')
    content_type = (file.content_type or 'application/octet-stream').split(';', 1)[0]
    if not content_type.startswith(('image/', 'video/')):
        raise HTTPException(422, '只接受图片或视频素材')
    asset_id = str(uuid4())
    file_name = (file.filename or 'asset').replace('/', '_')[:300]
    await object_store().put(user.id, asset_id, data, content_type, file_name)
    if project_id:
        cloud_store().add_project_asset(user.id, {
            'projectId': project_id,
            'assetId': asset_id,
            'kind': 'video' if content_type.startswith('video/') else 'image',
            'fileName': file_name,
            'createdAt': _now(),
        })
    return {
        'assetId': asset_id,
        'fileName': file_name,
        'contentType': content_type,
        'url': await object_store().signed_url(user.id, asset_id),
    }


@router.get('/api/media/{asset_id}/content')
async def media_content(asset_id: str, uid: str, exp: str, sig: str):
    _hosted()
    verify_media_signature(uid, asset_id, exp, sig)
    stored = await object_store().get(uid, asset_id)
    if stored is None:
        raise HTTPException(404, '素材不存在')
    return Response(
        content=stored.data,
        media_type=stored.content_type,
        headers={'Cache-Control': 'private, max-age=60', 'X-Content-Type-Options': 'nosniff'},
    )


@router.get('/api/media/{asset_id}')
async def media_meta(asset_id: str, request: Request):
    _hosted()
    user = _user(request)
    stored = await object_store().get(user.id, asset_id)
    if stored is None:
        raise HTTPException(404, '素材不存在')
    return {
        'assetId': asset_id,
        'fileName': stored.file_name,
        'contentType': stored.content_type,
        'url': await object_store().signed_url(user.id, asset_id),
    }


@router.delete('/api/media/{asset_id}')
async def delete_media_route(asset_id: str, request: Request):
    _hosted()
    user = _user(request)
    if cloud_store().asset_referenced(user.id, asset_id):
        return {'deleted': False}
    await object_store().delete(user.id, asset_id)
    return {'deleted': True}


@router.get('/api/projects/{project_id}/assets')
async def project_assets(project_id: str, request: Request):
    _hosted()
    return {'assets': cloud_store().list_project_assets(_user(request).id, project_id)}


@router.post('/api/project-assets')
async def register_project_asset(body: ProjectAssetIn, request: Request):
    _hosted()
    user = _user(request)
    if await object_store().get(user.id, body.assetId) is None:
        return {'registered': False}
    cloud_store().add_project_asset(user.id, body.model_dump())
    return {'registered': True}


@router.get('/api/global-assets')
async def global_assets(request: Request):
    _hosted()
    return {'assets': cloud_store().list_global_assets(_user(request).id)}


@router.post('/api/global-assets')
async def register_global_asset(body: GlobalAssetIn, request: Request):
    _hosted()
    user = _user(request)
    if await object_store().get(user.id, body.assetId) is None:
        raise HTTPException(404, '素材文件不可用，请重新上传。')
    cloud_store().add_global_asset(user.id, body.model_dump())
    return {'saved': True}


@router.get('/api/video-jobs/{job_id}')
async def read_video_job(job_id: str, request: Request):
    _hosted()
    user = _user(request)
    job = cloud_store().get_job(user.id, job_id)
    if job is None:
        raise HTTPException(404, '视频任务不存在')
    url = None
    if job['status'] == 'completed' and job.get('result_asset_id'):
        url = await object_store().signed_url(user.id, job['result_asset_id'])
    return public_job(job, url)


@router.post('/api/video-jobs/{job_id}/cancel')
async def cancel_video_job(job_id: str, request: Request):
    _hosted()
    user = _user(request)
    job = cloud_store().get_job(user.id, job_id)
    if job is None:
        raise HTTPException(404, '视频任务不存在')
    if job['status'] not in {'completed', 'failed', 'cancelled'}:
        job['status'] = 'cancelled'
        job['error'] = '已停止等待'
        job['updated_at'] = _now()
        cloud_store().save_job(job)
    return public_job(job)


@router.get('/api/agent-sessions')
async def read_agent_session(
    request: Request,
    project_id: str = Query(min_length=1, max_length=80),
    canvas_id: str = Query(min_length=1, max_length=80),
):
    _hosted()
    row = cloud_store().get_session(_user(request).id, project_id, canvas_id)
    return row or {'projectId': project_id, 'canvasId': canvas_id, 'messages': [], 'updatedAt': None}


@router.put('/api/agent-sessions')
async def write_agent_session(body: SessionIn, request: Request):
    _hosted()
    return cloud_store().save_session(_user(request).id, body.projectId, body.canvasId, body.messages)
