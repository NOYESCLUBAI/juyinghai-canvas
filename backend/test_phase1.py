"""Hosted-mode checks that do not need a live Supabase project."""
from __future__ import annotations

import logging
import time
from pathlib import Path
from unittest import IsolatedAsyncioTestCase

import httpx
import jwt
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt.algorithms import RSAAlgorithm

import backend.app as api
from backend.auth import reset_auth_state, set_jwks_override, verify_supabase_jwt
from backend.cloud_store import MemoryCloudStore
from backend.log_safety import redact
from backend.objects import MemoryObjectStore
from backend.rate_limit import LIMITER
from backend.video_jobs import advance_job, new_job


TEST_JWT_SECRET = 'test-secret-at-least-32-bytes-long'


def token_for(user_id: str, email: str, secret: str = TEST_JWT_SECRET, exp: int | None = None) -> str:
    payload = {
        'sub': user_id,
        'email': email,
        'aud': 'authenticated',
        'role': 'authenticated',
        'exp': exp if exp is not None else int(time.time()) + 600,
    }
    return jwt.encode(payload, secret, algorithm='HS256')


class LogRedactionTests(IsolatedAsyncioTestCase):
    def test_redacts_secrets_prompts_are_not_required_to_round_trip(self):
        raw = 'Authorization: Bearer sk-live-secret data:image/png;base64,aaaa api_key=another-secret token=signed'
        cleaned = redact(raw)
        self.assertNotIn('sk-live-secret', cleaned)
        self.assertNotIn('aaaa', cleaned)
        self.assertNotIn('another-secret', cleaned)
        self.assertNotIn('signed', cleaned)
        record = logging.LogRecord('test', logging.INFO, __file__, 1, 'prompt=%s key=%s', ('data:video/mp4;base64,bbbb', 'api_key=hidden'), None)
        from backend.log_safety import SecretRedactor
        SecretRedactor().filter(record)
        rendered = record.getMessage()
        self.assertNotIn('bbbb', rendered)
        self.assertNotIn('hidden', rendered)


class JwtTests(IsolatedAsyncioTestCase):
    def tearDown(self):
        reset_auth_state()

    def test_hs256_and_local_rsa_jwks(self):
        import os
        os.environ['SUPABASE_JWT_SECRET'] = TEST_JWT_SECRET
        user = verify_supabase_jwt(token_for('user-a', 'a@example.com'))
        self.assertEqual(user.id, 'user-a')
        self.assertEqual(user.email, 'a@example.com')
        with self.assertRaises(Exception):
            verify_supabase_jwt(token_for('user-a', 'a@example.com', exp=int(time.time()) - 120))

        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        public = json_jwk(key)
        set_jwks_override({'keys': [public]})
        signed = jwt.encode(
            {'sub': 'user-rsa', 'email': 'rsa@example.com', 'aud': 'authenticated', 'exp': int(time.time()) + 600},
            key, algorithm='RS256', headers={'kid': 'test-key'},
        )
        verified = verify_supabase_jwt(signed)
        self.assertEqual(verified.id, 'user-rsa')
        os.environ.pop('SUPABASE_JWT_SECRET', None)


def json_jwk(key):
    import json
    document = json.loads(RSAAlgorithm.to_jwk(key.public_key()))
    document['kid'] = 'test-key'
    document['alg'] = 'RS256'
    document['use'] = 'sig'
    return document


class HostedApiTests(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        import os
        self._env = {
            'MJH_HOSTED': 'true',
            'MJH_ALLOW_MEMORY_STORE': 'true',
            'MJH_CONFIG_ENCRYPTION_KEY': Fernet.generate_key().decode(),
            'SUPABASE_JWT_SECRET': TEST_JWT_SECRET,
            'MJH_INVITE_ALLOWLIST': 'a@example.com,b@example.com',
            'MJH_RATE_TEXT_PER_MINUTE': '2',
            'MJH_RATE_IMAGE_PER_MINUTE': '8',
            'MJH_RATE_VIDEO_PER_MINUTE': '4',
            'MJH_VIDEO_CONCURRENCY': '2',
        }
        self._previous = {key: os.environ.get(key) for key in self._env}
        os.environ.update(self._env)
        LIMITER.reset()
        reset_auth_state()
        api.app.state.cloud = MemoryCloudStore()
        api.app.state.objects = MemoryObjectStore()
        self.calls = []
        self.upstream = httpx.AsyncClient(transport=httpx.MockTransport(self.handle))
        api.app.state.http_client = self.upstream
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=api.app), base_url='http://test')
        self.user_a = {'Authorization': f'Bearer {token_for("user-a", "a@example.com")}'}
        self.user_b = {'Authorization': f'Bearer {token_for("user-b", "b@example.com")}'}

    async def asyncTearDown(self):
        import os
        await self.client.aclose()
        await self.upstream.aclose()
        for key, value in self._previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        LIMITER.reset()
        reset_auth_state()
        api.app.state.cloud = None
        api.app.state.objects = None

    def handle(self, request: httpx.Request):
        self.calls.append(request)
        if request.url.path.endswith('/models'):
            return httpx.Response(200, json={'data': [{'id': 'test-model'}]})
        if request.url.path.endswith('/chat/completions'):
            return httpx.Response(200, json={'choices': [{'message': {'content': '测试正文'}}]})
        if '/images/' in request.url.path:
            return httpx.Response(200, json={'data': [{'b64_json': 'aW1hZ2U='}]})
        if request.url.path.endswith('/videos'):
            return httpx.Response(200, json={'video_id': 'video-123'})
        if request.url.path == '/agnesapi':
            return httpx.Response(200, json={'status': 'completed', 'url': 'https://media.example/result.mp4', 'seconds': '5', 'size': '720P'})
        return httpx.Response(200, content=b'video-bytes', headers={'content-type': 'video/mp4'})

    async def test_liveness_health_and_anonymous_rejection(self):
        live = await self.client.get('/livez')
        self.assertEqual(live.status_code, 200)
        self.assertEqual(live.json(), {'ok': True})
        self.assertNotIn('model', live.text)
        health = await self.client.get('/api/health')
        self.assertEqual(health.json(), {'status': 'ok'})
        self.assertNotIn('configured', health.text)
        denied = await self.client.post('/api/chat', json={'prompt': 'hi', 'model_config_id': 'builtin:text:agnes-3.0-flash'})
        self.assertEqual(denied.status_code, 401)
        outsider = await self.client.get('/api/model-configs', headers={'Authorization': f'Bearer {token_for("user-x", "x@example.com")}'})
        self.assertEqual(outsider.status_code, 403)
        api.app.state.cloud.remember_invite('x@example.com')
        invited = await self.client.get('/api/model-configs', headers={'Authorization': f'Bearer {token_for("user-x", "x@example.com")}'})
        self.assertEqual(invited.status_code, 200)

    async def test_byok_isolation_encryption_and_no_env_fallback(self):
        listed = await self.client.get('/api/model-configs', headers=self.user_a)
        builtin = next(item for item in listed.json()['configs'] if item['id'] == 'builtin:text:agnes-3.0-flash')
        self.assertFalse(builtin['configured'])
        self.assertNotIn('"api_key"', listed.text)
        if api.settings.api_key:
            self.assertNotIn(api.settings.api_key, listed.text)
        missing = await self.client.post('/api/chat', headers=self.user_a, json={'prompt': 'hi'})
        self.assertEqual(missing.status_code, 422)
        self.assertEqual(self.calls, [])
        unconfigured = await self.client.post('/api/chat', headers=self.user_a, json={'prompt': 'hi', 'model_config_id': 'builtin:text:agnes-3.0-flash'})
        self.assertEqual(unconfigured.status_code, 503)
        created = await self.client.post('/api/model-configs', headers=self.user_a, json={
            'kind': 'text', 'protocol': 'chat', 'name': '甲的模型', 'model': 'test-model',
            'base_url': 'https://models.example/v1', 'api_key': 'user-a-secret',
        })
        self.assertEqual(created.status_code, 200, created.text)
        self.assertNotIn('user-a-secret', created.text)
        config_id = created.json()['id']
        ciphertext = api.app.state.cloud.model_ciphertext('user-a', config_id)
        self.assertNotIn('user-a-secret', ciphertext)
        from backend.crypto_box import KeyBox
        self.assertEqual(KeyBox.from_env().decrypt(ciphertext), 'user-a-secret')
        updated = created.json()
        updated.update(api_key='', name='改名')
        for field in ('configured', 'builtin', 'pricing', 'id'):
            updated.pop(field, None)
        saved = await self.client.put(f'/api/model-configs/{config_id}', headers=self.user_a, json=updated)
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(KeyBox.from_env().decrypt(api.app.state.cloud.model_ciphertext('user-a', config_id)), 'user-a-secret')
        other = await self.client.get('/api/model-configs', headers=self.user_b)
        self.assertFalse(any(item['id'] == config_id for item in other.json()['configs']))
        foreign = await self.client.post(
            f'/api/model-configs/{config_id}/test',
            headers={**self.user_b, 'Content-Type': 'application/json'},
            json={},
        )
        self.assertEqual(foreign.status_code, 404)
        LIMITER.reset()
        chat = await self.client.post('/api/chat', headers=self.user_a, json={'prompt': 'hi', 'model_config_id': config_id})
        self.assertEqual(chat.status_code, 200, chat.text)
        self.assertEqual(self.calls[-1].headers['authorization'], 'Bearer user-a-secret')
        self.assertNotIn('env', self.calls[-1].headers['authorization'])

    async def test_rate_limit_library_isolation_and_image_storage(self):
        created = await self.client.post('/api/model-configs', headers=self.user_a, json={
            'kind': 'text', 'protocol': 'chat', 'name': '甲', 'model': 'test-model',
            'base_url': 'https://models.example/v1', 'api_key': 'user-a-secret',
        })
        config_id = created.json()['id']
        for _ in range(2):
            response = await self.client.post('/api/chat', headers=self.user_a, json={'prompt': 'hi', 'model_config_id': config_id})
            self.assertEqual(response.status_code, 200, response.text)
        limited = await self.client.post('/api/chat', headers=self.user_a, json={'prompt': 'hi', 'model_config_id': config_id})
        self.assertEqual(limited.status_code, 429)

        project = {
            'version': 1,
            'projects': [{
                'id': 'project-a',
                'createdAt': '2026-10-19T00:00:00+00:00',
                'updatedAt': '2026-10-19T00:00:00+00:00',
                'favorite': False,
                'project': {
                    'version': 2, 'projectTitle': '甲的故事', 'activeCanvasId': 'canvas-1',
                    'canvases': [{
                        'id': 'canvas-1', 'title': '第 1 集', 'edges': [],
                        'viewport': {'x': 0, 'y': 0, 'zoom': 1},
                        'nodes': [{'id': 'node-1', 'data': {'kind': 'text', 'text': '只属于甲', 'assetUrl': 'data:image/png;base64,aaaa'}}],
                    }],
                },
            }],
        }
        saved = await self.client.put('/api/library', headers=self.user_a, json=project)
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertNotIn('assetUrl', saved.text)
        other = await self.client.get('/api/library', headers=self.user_b)
        self.assertEqual(other.json()['projects'], [])

        image_config = await self.client.post('/api/model-configs', headers=self.user_a, json={
            'kind': 'image', 'protocol': 'agnes-image', 'name': '图片', 'model': 'agnes-image-2.5-flash',
            'base_url': 'https://models.example/v1', 'api_key': 'image-secret',
        })
        generated = await self.client.post('/api/images/generate', headers=self.user_a, json={
            'prompt': '一张图', 'model_config_id': image_config.json()['id'],
        })
        self.assertEqual(generated.status_code, 200, generated.text)
        body = generated.json()
        self.assertNotIn('data_url', body['images'][0])
        self.assertTrue(body['images'][0]['asset_id'])
        stored = await api.app.state.objects.get('user-a', body['images'][0]['asset_id'])
        self.assertEqual(stored.data, b'image')
        self.assertIsNone(await api.app.state.objects.get('user-b', body['images'][0]['asset_id']))

    async def test_video_job_resumes_from_upstream_id(self):
        entry = {
            'id': 'custom:video', 'model': 'agnes-video-2.5-flash', 'base_url': 'https://models.example/v1',
            'query_base_url': 'https://models.example', 'api_key': 'video-secret', 'kind': 'video',
        }
        job = new_job(user_id='user-a', entry=entry, prompt='不要写进日志的提示词', aspect_ratio='16:9', duration=5, timeout_seconds=30)
        job = await advance_job(job, self.upstream, api.app.state.objects)
        self.assertEqual(job['upstream_video_id'], 'video-123')
        self.assertEqual(job['status'], 'running')
        self.assertEqual(sum(1 for call in self.calls if str(call.url).endswith('/videos')), 1)
        self.assertEqual(json_body(self.calls[0])['size'], '720P')
        job = await advance_job(job, self.upstream, api.app.state.objects)
        self.assertEqual(job['status'], 'completed')
        self.assertEqual(sum(1 for call in self.calls if str(call.url).endswith('/videos')), 1)
        stored = await api.app.state.objects.get('user-a', job['result_asset_id'])
        self.assertEqual(stored.data, b'video-bytes')
        api.app.state.cloud.create_job(job)
        api.app.state.cloud.save_job({**job, 'status': 'cancelled', 'error': '已停止等待'})
        cancelled = await self.client.get(f"/api/video-jobs/{job['id']}", headers=self.user_a)
        self.assertEqual(cancelled.status_code, 200)
        self.assertIn('可能仍会计费', cancelled.text)
        hidden = await self.client.get(f"/api/video-jobs/{job['id']}", headers=self.user_b)
        self.assertEqual(hidden.status_code, 404)

    def test_migration_enables_rls_for_the_same_user_id(self):
        sql = Path('supabase/migrations/20261019120000_phase1_cloud.sql').read_text()
        storage = Path('supabase/migrations/20261019120100_storage.sql').read_text()
        for table in ('projects', 'project_assets', 'global_assets', 'model_configs', 'video_jobs', 'agent_sessions', 'invite_allowlist'):
            self.assertIn(f'alter table public.{table} enable row level security', sql)
        self.assertIn('user_id = auth.uid()', sql)
        self.assertIn("auth.uid()::text", storage)
        self.assertIn('manjinhai-media', storage)
        self.assertNotIn('service_role', sql.lower())


def json_body(request: httpx.Request):
    import json
    return json.loads(request.content)
