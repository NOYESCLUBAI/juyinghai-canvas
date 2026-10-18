from __future__ import annotations

import asyncio
import json
import os
import tempfile
from dataclasses import replace
from pathlib import Path
from unittest import IsolatedAsyncioTestCase
from unittest.mock import patch

import httpx
import backend.app as api
from backend.model_configs import ConfigStore, ConfigInput


class ModelConfigTests(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.settings = replace(api.settings, api_key='env-secret', image_api_key='env-image-secret', video_api_key='env-video-secret')
        self.store = ConfigStore(Path(self.folder.name) / 'models.json', self.settings)
        self.patcher = patch.object(api, 'config_store', self.store)
        self.patcher.start()
        self.calls = []
        self.response_status = 200
        self.probe_status = 200
        self.video_result = {'status': 'completed', 'metadata': {'url': 'https://media.example/result.mp4'}}
        self.upstream = httpx.AsyncClient(transport=httpx.MockTransport(self.handle))
        api.app.state.http_client = self.upstream
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=api.app), base_url='http://test')

    async def asyncTearDown(self):
        await self.client.aclose()
        await self.upstream.aclose()
        self.patcher.stop()
        self.folder.cleanup()

    def handle(self, request):
        self.calls.append(request)
        if request.url.path.endswith('/models'):
            return httpx.Response(self.probe_status, json={'data': [{'id': 'test-model'}]})
        if self.response_status != 200:
            return httpx.Response(self.response_status, json={'error': {'message': 'echo secret-key'}})
        if request.url.path.endswith('/chat/completions'):
            return httpx.Response(200, json={'choices': [{'message': {'content': '测试正文'}}]})
        if '/images/' in request.url.path:
            return httpx.Response(200, json={'data': [{'b64_json': 'aW1hZ2U='}]})
        if request.url.path.endswith('/videos'):
            return httpx.Response(200, json={'video_id': 'video-123'})
        if request.url.path == '/agnesapi':
            return httpx.Response(200, json=self.video_result)
        return httpx.Response(200, content=b'video', headers={'content-type': 'video/mp4'})

    async def create(self, kind='text', protocol='chat', model='test-model', base_url='https://models.example/v1'):
        response = await self.client.post('/api/model-configs', json={'kind': kind, 'protocol': protocol, 'name': '我的模型', 'model': model, 'base_url': base_url, 'api_key': 'secret-key'})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertNotIn('secret-key', response.text)
        self.assertNotIn('api_key', response.json())
        return response.json()

    async def test_crud_permissions_persistence_and_blank_key(self):
        config = await self.create()
        self.assertEqual(os.stat(self.store.path).st_mode & 0o777, 0o600)
        restarted = ConfigStore(self.store.path, self.settings)
        self.assertEqual(restarted.get(config['id'])['api_key'], 'secret-key')
        updated = {k: config[k] for k in ('kind', 'protocol', 'name', 'model', 'base_url')}
        updated.update(api_key='', name='改名')
        response = await self.client.put('/api/model-configs/' + config['id'], json=updated)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.store.get(config['id'])['api_key'], 'secret-key')
        listed = await self.client.get('/api/model-configs')
        self.assertNotIn('secret', listed.text)
        self.assertEqual(listed.headers['cache-control'], 'no-store')
        await self.client.delete('/api/model-configs/' + config['id'])
        response = await self.client.post('/api/chat', json={'prompt': 'hi', 'model_config_id': config['id']})
        self.assertEqual(response.status_code, 404)
        self.assertEqual(self.calls, [])

    async def test_invalid_input_and_origin_do_not_echo_key(self):
        response = await self.client.post('/api/model-configs', json={'api_key': 'secret-key', 'base_url': 'https://user:secret-key@example.com'})
        self.assertEqual(response.status_code, 422)
        self.assertNotIn('secret-key', response.text)
        response = await self.client.get('/api/model-configs', headers={'origin': 'https://untrusted.example'})
        self.assertEqual(response.status_code, 403)

    async def test_text_routes_correct_key_and_url(self):
        config = await self.create(base_url='https://models.example/v1/chat/completions')
        response = await self.client.post('/api/chat', json={'prompt': 'hi', 'model': 'ignored-model', 'model_config_id': config['id']})
        self.assertEqual(response.status_code, 200)
        call = self.calls[0]
        self.assertEqual(str(call.url), 'https://models.example/v1/chat/completions')
        self.assertEqual(call.headers['authorization'], 'Bearer secret-key')
        self.assertEqual(json.loads(call.content)['model'], 'test-model')
        wrong = await self.client.post('/api/images/generate', json={'prompt': 'hi', 'model_config_id': config['id']})
        self.assertEqual(wrong.status_code, 422)

    async def test_agnes_shared_override_and_legacy_request(self):
        response = await self.client.put('/api/model-configs/agnes', json={'base_url': 'https://new.example/v1', 'api_key': 'shared-secret'})
        self.assertEqual(response.status_code, 200)
        for kind, model in [('text', 'agnes-3.0-flash'), ('image', 'agnes-image-2.5-flash'), ('video', 'agnes-video-2.5-flash')]:
            entry = self.store.get(f'builtin:{kind}:{model}')
            self.assertEqual(entry['api_key'], 'shared-secret')
            self.assertEqual(entry['base_url'], 'https://new.example/v1')
        response = await self.client.post('/api/chat', json={'prompt': 'hi', 'model': 'agnes-3.0-flash'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.calls[0].headers['authorization'], 'Bearer shared-secret')

    async def test_snapshot_not_changed_by_edit(self):
        entry = await self.create()
        snapshot, model, _ = api.request_settings('text', entry['id'], None)
        self.store.save(ConfigInput(kind='text', protocol='chat', name='changed', model='other', base_url='https://other.example/v1', api_key='new-secret'), entry['id'])
        await api.call_agnes(self.upstream, model, api.ChatRequest(prompt='hi'), snapshot)
        self.assertEqual(self.calls[0].headers['authorization'], 'Bearer secret-key')
        self.assertEqual(json.loads(self.calls[0].content)['model'], 'test-model')

    async def test_both_image_protocols(self):
        for protocol in ('agnes-image', 'openai-image'):
            entry = await self.create('image', protocol)
            response = await self.client.post('/api/images/generate', json={'prompt': 'hi', 'model_config_id': entry['id'], 'references': [{'kind': 'image', 'label': 'ref', 'content': 'data:image/png;base64,aGVsbG8='}]})
            self.assertEqual(response.status_code, 200, response.text)
            call = self.calls[-1]
            self.assertEqual(call.headers['authorization'], 'Bearer secret-key')
            self.assertTrue(call.url.path.endswith('/images/generations' if protocol == 'agnes-image' else '/images/edits'))
            self.assertIn('application/json' if protocol == 'agnes-image' else 'multipart/form-data', call.headers['content-type'])

    async def test_both_video_payloads_and_polling(self):
        for model in ('agnes-video-v2.0', 'agnes-video-2.5', 'agnes-video-2.5-flash'):
            self.calls.clear()
            entry = await self.create('video', 'agnes-video', model)
            response = await self.client.post('/api/videos/generate', json={'prompt': 'hi', 'model_config_id': entry['id'], 'duration': 5, 'aspect_ratio': '16:9'})
            self.assertEqual(response.status_code, 200, response.text)
            payload = json.loads(self.calls[0].content)
            if model.startswith('agnes-video-2.5'):
                self.assertEqual(payload['size'], '720P')
                self.assertEqual(payload['seconds'], '5')
                self.assertEqual(payload['mode'], 'text')
                self.assertEqual(payload['aspect_ratio'], '16:9')
                self.assertNotIn('num_frames', payload)
                self.assertNotIn('width', payload)
            else:
                self.assertEqual(payload['num_frames'], 121)
                self.assertNotIn('seconds', payload)
            self.assertEqual(self.calls[1].url.params['video_id'], 'video-123')
            self.assertEqual(self.calls[1].url.params['model_name'], model)
            self.assertNotIn('authorization', self.calls[-1].headers)

    async def test_video_25_reads_top_level_result_url(self):
        self.video_result = {
            'status': 'completed',
            'metadata': None,
            'url': 'https://media.example/flash.mp4',
            'seconds': '5',
            'size': '720P',
        }
        entry = await self.create('video', 'agnes-video', 'agnes-video-2.5-flash')
        response = await self.client.post('/api/videos/generate', json={'prompt': 'hi', 'model_config_id': entry['id'], 'duration': 5, 'aspect_ratio': '9:16'})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(str(self.calls[-1].url), 'https://media.example/flash.mp4')
        payload = json.loads(self.calls[0].content)
        self.assertEqual(payload['aspect_ratio'], '9:16')
        self.assertEqual(payload['size'], '720P')

    async def test_catalog_labels_and_latest_free_defaults(self):
        with patch.dict(os.environ):
            for key in ('MJH_LLM_MODEL', 'MJH_LLM_MODELS', 'MJH_IMAGE_MODEL', 'MJH_IMAGE_MODELS', 'MJH_VIDEO_MODEL', 'MJH_VIDEO_MODELS'):
                os.environ.pop(key, None)
            fresh = api.Settings.from_environment()
        self.assertEqual(fresh.model, 'agnes-3.0-flash')
        self.assertEqual(fresh.image_model, 'agnes-image-2.5-flash')
        self.assertEqual(fresh.video_model, 'agnes-video-2.5-flash')
        self.assertIn('agnes-2.5-flash', fresh.models)
        store = ConfigStore(self.store.path, fresh)
        listed = {entry['id']: entry for entry in store.all() if entry['builtin']}
        self.assertEqual(listed['builtin:text:agnes-3.0-flash']['pricing'], '当前免费')
        self.assertEqual(listed['builtin:text:agnes-2.5-flash']['pricing'], '当前免费')
        self.assertEqual(listed['builtin:text:agnes-2.5-pro']['pricing'], '付费')
        self.assertEqual(listed['builtin:text:agnes-2.5-pro-beta']['pricing'], '付费')
        self.assertEqual(listed['builtin:text:agnes-3.0-pro']['pricing'], '即将上线 · 付费')
        self.assertEqual(listed['builtin:image:agnes-image-2.5-flash']['pricing'], '当前免费')
        self.assertEqual(listed['builtin:image:agnes-image-2.1-flash']['pricing'], '当前免费')
        self.assertEqual(listed['builtin:image:agnes-image-2.0-flash']['pricing'], '当前免费')
        self.assertEqual(listed['builtin:video:agnes-video-2.5-flash']['pricing'], '限时免费')
        self.assertEqual(listed['builtin:video:agnes-video-2.5']['pricing'], '付费')
        retired = listed['builtin:video:agnes-video-v2.0']
        self.assertEqual(retired['pricing'], '已下架')
        self.assertEqual(retired['model'], 'agnes-video-v2.0')

    async def test_connection_probe_never_generates(self):
        entry = await self.create()
        for code, status in [(200, 'reachable'), (404, 'unverified'), (401, 'error'), (429, 'error'), (503, 'error')]:
            self.probe_status = code
            response = await self.client.post(f"/api/model-configs/{entry['id']}/test", json={})
            self.assertEqual(response.json()['status'], status)
        self.assertTrue(all(c.method == 'GET' and c.url.path.endswith('/models') for c in self.calls))

    async def test_upstream_failures_are_redacted_without_fallback(self):
        entry = await self.create()
        for code in (401, 404, 429, 504):
            self.calls.clear()
            self.response_status = code
            response = await self.client.post('/api/chat', json={'prompt': 'hi', 'model_config_id': entry['id']})
            self.assertEqual(response.status_code, code)
            self.assertNotIn('secret-key', response.text)
            self.assertEqual(len(self.calls), 1)

    async def test_corrupt_file_is_not_overwritten(self):
        self.store.path.write_text('broken')
        response = await self.client.get('/api/model-configs')
        self.assertEqual(response.status_code, 503)
        self.assertEqual(self.store.path.read_text(), 'broken')
