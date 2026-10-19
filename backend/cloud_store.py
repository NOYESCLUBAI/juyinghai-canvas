"""Per-user project, model, job and session rows.

MemoryCloudStore is the unit-test and smoke backend. PostgresCloudStore talks
to the Supabase database described in supabase/migrations. The database role
used here bypasses RLS, so every method filters on user_id.
"""
from __future__ import annotations

import json
from copy import deepcopy
from datetime import datetime, timezone
from threading import RLock
from uuid import UUID

from fastapi import HTTPException

from backend.crypto_box import KeyBox


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _strip_entry(entry: dict) -> dict:
    project = entry.get('project')
    if not isinstance(project, dict):
        return entry
    canvases = []
    for canvas in project.get('canvases') or []:
        if not isinstance(canvas, dict):
            canvases.append(canvas)
            continue
        nodes = []
        for node in canvas.get('nodes') or []:
            if isinstance(node, dict) and isinstance(node.get('data'), dict):
                data = {key: value for key, value in node['data'].items() if key != 'assetUrl'}
                nodes.append({**node, 'data': data})
            else:
                nodes.append(node)
        canvases.append({**canvas, 'nodes': nodes})
    return {**entry, 'project': {**project, 'canvases': canvases}}


def prepare_library(payload: dict) -> dict:
    if not isinstance(payload, dict) or payload.get('version') != 1 or not isinstance(payload.get('projects'), list):
        raise HTTPException(422, '项目列表格式无效')
    if len(payload['projects']) > 200:
        raise HTTPException(413, '项目数量超过限制')
    projects = []
    seen: set[str] = set()
    for entry in payload['projects']:
        if not isinstance(entry, dict) or not isinstance(entry.get('id'), str) or not entry['id']:
            raise HTTPException(422, '项目列表格式无效')
        project = entry.get('project')
        if not isinstance(project, dict) or project.get('version') != 2 or not isinstance(project.get('canvases'), list) or not project['canvases']:
            raise HTTPException(422, '项目列表格式无效')
        if entry['id'] in seen:
            raise HTTPException(422, '项目列表格式无效')
        seen.add(entry['id'])
        projects.append(_strip_entry(entry))
    last = payload.get('lastOpenedProjectId')
    if last is not None and last != '' and not isinstance(last, str):
        raise HTTPException(422, '项目列表格式无效')
    library = {'version': 1, 'projects': projects, 'lastOpenedProjectId': last or None}
    if len(json.dumps(library, ensure_ascii=False).encode()) > 8_000_000:
        raise HTTPException(413, '项目内容过大')
    return library


def _entry_references(entry: dict, asset_id: str) -> bool:
    if entry.get('coverAssetId') == asset_id:
        return True
    project = entry.get('project') or {}
    for canvas in project.get('canvases') or []:
        for node in canvas.get('nodes') or []:
            data = node.get('data') if isinstance(node, dict) else None
            if isinstance(data, dict) and data.get('assetId') == asset_id:
                return True
    return False


def _uid(value: str) -> UUID:
    try:
        return UUID(str(value))
    except (ValueError, TypeError, AttributeError) as exc:
        raise HTTPException(401, '账号标识无效') from exc


class MemoryCloudStore:
    def __init__(self) -> None:
        self.lock = RLock()
        self.projects: dict[str, dict[str, dict]] = {}
        self.meta: dict[str, str | None] = {}
        self.project_assets: dict[str, list[dict]] = {}
        self.global_assets: dict[str, dict[str, dict]] = {}
        self.models: dict[str, dict[str, dict]] = {}
        self.agnes: dict[str, dict] = {}
        self.jobs: dict[str, dict] = {}
        self.sessions: dict[tuple[str, str, str], dict] = {}
        self.invites: set[str] = set()

    def _box(self) -> KeyBox:
        return KeyBox.from_env()

    def read_library(self, user_id: str) -> dict:
        with self.lock:
            projects = [deepcopy(entry) for entry in self.projects.get(user_id, {}).values()]
        projects.sort(key=lambda entry: entry.get('updatedAt') or '', reverse=True)
        return {'version': 1, 'projects': projects, 'lastOpenedProjectId': self.meta.get(user_id)}

    def replace_library(self, user_id: str, payload: dict) -> dict:
        library = prepare_library(payload)
        with self.lock:
            self.projects[user_id] = {entry['id']: deepcopy(entry) for entry in library['projects']}
            self.meta[user_id] = library.get('lastOpenedProjectId')
        return self.read_library(user_id)

    def list_project_assets(self, user_id: str, project_id: str) -> list[dict]:
        with self.lock:
            rows = [deepcopy(row) for row in self.project_assets.get(user_id, []) if row['projectId'] == project_id]
        return sorted(rows, key=lambda row: row['createdAt'], reverse=True)

    def add_project_asset(self, user_id: str, asset: dict) -> None:
        with self.lock:
            rows = self.project_assets.setdefault(user_id, [])
            if any(row['projectId'] == asset['projectId'] and row['assetId'] == asset['assetId'] for row in rows):
                return
            rows.append(deepcopy(asset))

    def list_global_assets(self, user_id: str) -> list[dict]:
        with self.lock:
            rows = [deepcopy(row) for row in self.global_assets.get(user_id, {}).values()]
        return sorted(rows, key=lambda row: row.get('savedAt') or '', reverse=True)

    def add_global_asset(self, user_id: str, asset: dict) -> None:
        with self.lock:
            current = self.global_assets.setdefault(user_id, {})
            if asset['assetId'] not in current:
                current[asset['assetId']] = deepcopy(asset)

    def asset_referenced(self, user_id: str, asset_id: str) -> bool:
        with self.lock:
            if any(row['assetId'] == asset_id for row in self.project_assets.get(user_id, [])):
                return True
            if asset_id in self.global_assets.get(user_id, {}):
                return True
            return any(_entry_references(entry, asset_id) for entry in self.projects.get(user_id, {}).values())

    def put_model(self, user_id: str, entry: dict) -> dict:
        box = self._box()
        stored = {key: value for key, value in entry.items() if key != 'api_key'}
        stored['api_key_ciphertext'] = box.encrypt(entry['api_key'])
        with self.lock:
            self.models.setdefault(user_id, {})[entry['id']] = stored
        return self._public_model(stored, entry['api_key'])

    def list_models(self, user_id: str) -> list[dict]:
        with self.lock:
            rows = [deepcopy(row) for row in self.models.get(user_id, {}).values()]
        if not rows:
            return []
        box = self._box()
        result = []
        for row in rows:
            secret = box.decrypt(row.pop('api_key_ciphertext'))
            row['api_key'] = secret
            result.append(row)
        return result

    def model_ciphertext(self, user_id: str, config_id: str) -> str:
        with self.lock:
            row = self.models.get(user_id, {}).get(config_id)
        if row is None:
            raise HTTPException(404, '自定义模型不存在')
        return row['api_key_ciphertext']

    def delete_model(self, user_id: str, config_id: str) -> None:
        with self.lock:
            rows = self.models.get(user_id, {})
            if config_id not in rows:
                raise HTTPException(404, '自定义模型不存在')
            del rows[config_id]

    def get_agnes(self, user_id: str) -> dict | None:
        with self.lock:
            row = self.agnes.get(user_id)
            if row is None:
                return None
            ciphertext = row['api_key_ciphertext']
            base_url = row['base_url']
        return {'base_url': base_url, 'api_key': self._box().decrypt(ciphertext)}

    def agnes_ciphertext(self, user_id: str) -> str:
        with self.lock:
            row = self.agnes.get(user_id)
        if row is None:
            raise HTTPException(404, '尚未保存 Agnes 连接')
        return row['api_key_ciphertext']

    def save_agnes(self, user_id: str, base_url: str, api_key: str) -> None:
        stored = {'base_url': base_url, 'api_key_ciphertext': self._box().encrypt(api_key)}
        with self.lock:
            self.agnes[user_id] = stored

    def create_job(self, job: dict) -> dict:
        stored = deepcopy(job)
        stored['updated_at'] = _now()
        with self.lock:
            self.jobs[stored['id']] = stored
        return deepcopy(stored)

    def get_job(self, user_id: str, job_id: str) -> dict | None:
        with self.lock:
            job = self.jobs.get(job_id)
            if job is None or job['user_id'] != user_id:
                return None
            return deepcopy(job)

    def save_job(self, job: dict) -> None:
        with self.lock:
            current = self.jobs.get(job['id'])
            if current is None or current['user_id'] != job['user_id']:
                raise HTTPException(404, '视频任务不存在')
            self.jobs[job['id']] = deepcopy(job)

    def list_jobs_by_status(self, statuses: tuple[str, ...]) -> list[dict]:
        with self.lock:
            return [deepcopy(job) for job in self.jobs.values() if job['status'] in statuses]

    def count_open_jobs(self, user_id: str) -> int:
        with self.lock:
            return sum(1 for job in self.jobs.values() if job['user_id'] == user_id and job['status'] in {'queued', 'running'})

    def get_session(self, user_id: str, project_id: str, canvas_id: str) -> dict | None:
        with self.lock:
            row = self.sessions.get((user_id, project_id, canvas_id))
            return deepcopy(row) if row else None

    def save_session(self, user_id: str, project_id: str, canvas_id: str, messages: list) -> dict:
        if not isinstance(messages, list) or len(json.dumps(messages, ensure_ascii=False).encode()) > 200_000:
            raise HTTPException(413, '会话过长')
        row = {'projectId': project_id, 'canvasId': canvas_id, 'messages': messages, 'updatedAt': _now()}
        with self.lock:
            self.sessions[(user_id, project_id, canvas_id)] = deepcopy(row)
        return row

    def invite_contains(self, email: str) -> bool:
        if not email:
            return False
        with self.lock:
            return email.strip().lower() in self.invites

    def remember_invite(self, email: str) -> None:
        with self.lock:
            self.invites.add(email.strip().lower())

    @staticmethod
    def _public_model(stored: dict, api_key: str) -> dict:
        return {**{key: value for key, value in stored.items() if key != 'api_key_ciphertext'}, 'api_key': api_key}


class PostgresCloudStore:
    """Same methods as MemoryCloudStore, backed by Supabase Postgres."""

    def __init__(self, url: str) -> None:
        self.url = url

    def _box(self) -> KeyBox:
        return KeyBox.from_env()

    def _connect(self):
        try:
            import psycopg
        except ImportError as exc:
            raise HTTPException(503, '云端数据库驱动未安装') from exc
        try:
            return psycopg.connect(self.url, connect_timeout=10)
        except Exception as exc:
            raise HTTPException(503, '云端数据库暂时无法连接') from exc

    def read_library(self, user_id: str) -> dict:
        uid = _uid(user_id)
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute('select document from public.projects where user_id = %s order by updated_at desc', (uid,))
                projects = [row[0] for row in cur.fetchall()]
                cur.execute('select last_opened_project_id from public.library_meta where user_id = %s', (uid,))
                meta = cur.fetchone()
        return {'version': 1, 'projects': projects, 'lastOpenedProjectId': meta[0] if meta else None}

    def replace_library(self, user_id: str, payload: dict) -> dict:
        library = prepare_library(payload)
        uid = _uid(user_id)
        from psycopg.types.json import Json
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute('delete from public.projects where user_id = %s', (uid,))
                for entry in library['projects']:
                    cur.execute(
                        '''insert into public.projects
                           (id, user_id, document, created_at, updated_at, last_opened_at, favorite, trashed_at, cover_asset_id)
                           values (%s, %s, %s, %s, %s, %s, %s, %s, %s)''',
                        (
                            entry['id'], uid, Json(entry), entry.get('createdAt') or _now(), entry.get('updatedAt') or _now(),
                            entry.get('lastOpenedAt'), bool(entry.get('favorite')), entry.get('trashedAt'), entry.get('coverAssetId'),
                        ),
                    )
                cur.execute(
                    '''insert into public.library_meta (user_id, last_opened_project_id)
                       values (%s, %s)
                       on conflict (user_id) do update set last_opened_project_id = excluded.last_opened_project_id''',
                    (uid, library.get('lastOpenedProjectId')),
                )
            conn.commit()
        return self.read_library(user_id)

    def list_project_assets(self, user_id: str, project_id: str) -> list[dict]:
        uid = _uid(user_id)
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    '''select project_id, asset_id, kind, file_name, created_at
                       from public.project_assets where user_id = %s and project_id = %s
                       order by created_at desc''',
                    (uid, project_id),
                )
                return [_asset_row(row) for row in cur.fetchall()]

    def add_project_asset(self, user_id: str, asset: dict) -> None:
        uid = _uid(user_id)
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    '''insert into public.project_assets (user_id, project_id, asset_id, kind, file_name, created_at)
                       values (%s, %s, %s, %s, %s, %s)
                       on conflict (user_id, project_id, asset_id) do nothing''',
                    (uid, asset['projectId'], asset['assetId'], asset['kind'], asset['fileName'], asset['createdAt']),
                )
            conn.commit()

    def list_global_assets(self, user_id: str) -> list[dict]:
        uid = _uid(user_id)
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    '''select project_id, asset_id, kind, file_name, created_at, saved_at
                       from public.global_assets where user_id = %s order by saved_at desc''',
                    (uid,),
                )
                rows = []
                for project_id, asset_id, kind, file_name, created_at, saved_at in cur.fetchall():
                    rows.append({
                        'projectId': project_id or '', 'assetId': asset_id, 'kind': kind,
                        'fileName': file_name, 'createdAt': _iso(created_at), 'savedAt': _iso(saved_at),
                    })
                return rows

    def add_global_asset(self, user_id: str, asset: dict) -> None:
        uid = _uid(user_id)
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    '''insert into public.global_assets
                       (user_id, asset_id, project_id, kind, file_name, created_at, saved_at)
                       values (%s, %s, %s, %s, %s, %s, %s)
                       on conflict (user_id, asset_id) do nothing''',
                    (uid, asset['assetId'], asset.get('projectId'), asset['kind'], asset['fileName'], asset['createdAt'], asset['savedAt']),
                )
            conn.commit()

    def asset_referenced(self, user_id: str, asset_id: str) -> bool:
        uid = _uid(user_id)
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute('select 1 from public.project_assets where user_id = %s and asset_id = %s limit 1', (uid, asset_id))
                if cur.fetchone():
                    return True
                cur.execute('select 1 from public.global_assets where user_id = %s and asset_id = %s limit 1', (uid, asset_id))
                if cur.fetchone():
                    return True
                cur.execute('select document from public.projects where user_id = %s', (uid,))
                return any(_entry_references(row[0], asset_id) for row in cur.fetchall())

    def put_model(self, user_id: str, entry: dict) -> dict:
        uid = _uid(user_id)
        ciphertext = self._box().encrypt(entry['api_key'])
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    '''insert into public.model_configs
                       (id, user_id, name, kind, protocol, base_url, model, api_key_ciphertext)
                       values (%s, %s, %s, %s, %s, %s, %s, %s)
                       on conflict (user_id, id) do update set
                         name = excluded.name, kind = excluded.kind, protocol = excluded.protocol,
                         base_url = excluded.base_url, model = excluded.model,
                         api_key_ciphertext = excluded.api_key_ciphertext''',
                    (entry['id'], uid, entry['name'], entry['kind'], entry['protocol'], entry['base_url'], entry['model'], ciphertext),
                )
            conn.commit()
        return entry

    def list_models(self, user_id: str) -> list[dict]:
        uid = _uid(user_id)
        box = self._box()
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    '''select id, name, kind, protocol, base_url, model, api_key_ciphertext
                       from public.model_configs where user_id = %s''',
                    (uid,),
                )
                rows = cur.fetchall()
        return [{
            'id': row[0], 'name': row[1], 'kind': row[2], 'protocol': row[3], 'base_url': row[4],
            'model': row[5], 'builtin': False, 'pricing': '', 'api_key': box.decrypt(row[6]),
        } for row in rows]

    def model_ciphertext(self, user_id: str, config_id: str) -> str:
        uid = _uid(user_id)
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute('select api_key_ciphertext from public.model_configs where user_id = %s and id = %s', (uid, config_id))
                row = cur.fetchone()
        if row is None:
            raise HTTPException(404, '自定义模型不存在')
        return row[0]

    def delete_model(self, user_id: str, config_id: str) -> None:
        uid = _uid(user_id)
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute('delete from public.model_configs where user_id = %s and id = %s', (uid, config_id))
                if cur.rowcount == 0:
                    raise HTTPException(404, '自定义模型不存在')
            conn.commit()

    def get_agnes(self, user_id: str) -> dict | None:
        uid = _uid(user_id)
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute('select base_url, api_key_ciphertext from public.agnes_connections where user_id = %s', (uid,))
                row = cur.fetchone()
        if row is None:
            return None
        return {'base_url': row[0], 'api_key': self._box().decrypt(row[1])}

    def agnes_ciphertext(self, user_id: str) -> str:
        uid = _uid(user_id)
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute('select api_key_ciphertext from public.agnes_connections where user_id = %s', (uid,))
                row = cur.fetchone()
        if row is None:
            raise HTTPException(404, '尚未保存 Agnes 连接')
        return row[0]

    def save_agnes(self, user_id: str, base_url: str, api_key: str) -> None:
        uid = _uid(user_id)
        ciphertext = self._box().encrypt(api_key)
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    '''insert into public.agnes_connections (user_id, base_url, api_key_ciphertext)
                       values (%s, %s, %s)
                       on conflict (user_id) do update set base_url = excluded.base_url,
                         api_key_ciphertext = excluded.api_key_ciphertext''',
                    (uid, base_url, ciphertext),
                )
            conn.commit()

    def create_job(self, job: dict) -> dict:
        self._upsert_job(job)
        return job

    def get_job(self, user_id: str, job_id: str) -> dict | None:
        uid = _uid(user_id)
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute('select payload from public.video_jobs where user_id = %s and id = %s', (uid, job_id))
                row = cur.fetchone()
        return row[0] if row else None

    def save_job(self, job: dict) -> None:
        uid = _uid(job['user_id'])
        from psycopg.types.json import Json
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    '''update public.video_jobs set status = %s, payload = %s, updated_at = now()
                       where id = %s and user_id = %s''',
                    (job['status'], Json(job), job['id'], uid),
                )
                if cur.rowcount == 0:
                    raise HTTPException(404, '视频任务不存在')
            conn.commit()

    def list_jobs_by_status(self, statuses: tuple[str, ...]) -> list[dict]:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute('select payload from public.video_jobs where status = any(%s)', (list(statuses),))
                return [row[0] for row in cur.fetchall()]

    def count_open_jobs(self, user_id: str) -> int:
        uid = _uid(user_id)
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "select count(*) from public.video_jobs where user_id = %s and status in ('queued', 'running')",
                    (uid,),
                )
                return int(cur.fetchone()[0])

    def get_session(self, user_id: str, project_id: str, canvas_id: str) -> dict | None:
        uid = _uid(user_id)
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    '''select messages, updated_at from public.agent_sessions
                       where user_id = %s and project_id = %s and canvas_id = %s''',
                    (uid, project_id, canvas_id),
                )
                row = cur.fetchone()
        if row is None:
            return None
        return {'projectId': project_id, 'canvasId': canvas_id, 'messages': row[0], 'updatedAt': _iso(row[1])}

    def save_session(self, user_id: str, project_id: str, canvas_id: str, messages: list) -> dict:
        if not isinstance(messages, list) or len(json.dumps(messages, ensure_ascii=False).encode()) > 200_000:
            raise HTTPException(413, '会话过长')
        uid = _uid(user_id)
        from psycopg.types.json import Json
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    '''insert into public.agent_sessions (user_id, project_id, canvas_id, messages, updated_at)
                       values (%s, %s, %s, %s, now())
                       on conflict (user_id, project_id, canvas_id)
                       do update set messages = excluded.messages, updated_at = now()
                       returning updated_at''',
                    (uid, project_id, canvas_id, Json(messages)),
                )
                updated = cur.fetchone()[0]
            conn.commit()
        return {'projectId': project_id, 'canvasId': canvas_id, 'messages': messages, 'updatedAt': _iso(updated)}

    def invite_contains(self, email: str) -> bool:
        if not email:
            return False
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute('select 1 from public.invite_allowlist where lower(email) = lower(%s) limit 1', (email.strip(),))
                return cur.fetchone() is not None

    def remember_invite(self, email: str) -> None:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    'insert into public.invite_allowlist (email) values (%s) on conflict (email) do nothing',
                    (email.strip().lower(),),
                )
            conn.commit()

    def _upsert_job(self, job: dict) -> None:
        uid = _uid(job['user_id'])
        from psycopg.types.json import Json
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    '''insert into public.video_jobs (id, user_id, status, payload)
                       values (%s, %s, %s, %s)
                       on conflict (id) do update set status = excluded.status, payload = excluded.payload, updated_at = now()
                       where public.video_jobs.user_id = excluded.user_id''',
                    (job['id'], uid, job['status'], Json(job)),
                )
            conn.commit()


def _iso(value) -> str:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat()
    return str(value)


def _asset_row(row) -> dict:
    project_id, asset_id, kind, file_name, created_at = row
    return {'projectId': project_id, 'assetId': asset_id, 'kind': kind, 'fileName': file_name, 'createdAt': _iso(created_at)}
