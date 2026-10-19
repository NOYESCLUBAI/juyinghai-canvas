from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import IsolatedAsyncioTestCase
from unittest.mock import patch

import httpx

import backend.app as api
from backend.model_configs import ConfigStore


class AgentProxyTests(IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.folder = TemporaryDirectory()
        self.settings = replace(
            api.settings,
            api_key="env-secret",
            base_url="https://models.example/v1",
            model="agnes-3.0-flash",
        )
        self.store = ConfigStore(Path(self.folder.name) / "models.json", self.settings)
        self.patcher = patch.object(api, "config_store", self.store)
        self.patcher.start()
        self.calls = []
        self.upstream_status = 200
        self.upstream_body = {
            "id": "chatcmpl-1",
            "choices": [{
                "finish_reason": "tool_calls",
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "read_cards", "arguments": "{\"cardIds\":[\"c3\"]}"},
                    }],
                },
            }],
        }
        self.upstream = httpx.AsyncClient(transport=httpx.MockTransport(self.handle))
        api.app.state.http_client = self.upstream
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=api.app), base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()
        await self.upstream.aclose()
        self.patcher.stop()
        self.folder.cleanup()

    def handle(self, request: httpx.Request):
        self.calls.append(request)
        if self.upstream_status >= 400:
            return httpx.Response(self.upstream_status, json={"error": {"message": "echo env-secret"}})
        if request.url.path.endswith("/chat/completions") and json.loads(request.content).get("stream") is True:
            return httpx.Response(200, content=b'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_1"}]}}]}\n\n', headers={"content-type": "text/event-stream"})
        return httpx.Response(200, json=self.upstream_body)

    def payload(self):
        return {
            "model": "agnes-3.0-flash",
            "messages": [{"role": "user", "content": "读一下画布"}],
            "tools": [{"type": "function", "function": {"name": "read_cards", "parameters": {"type": "object"}}}],
            "tool_choice": "auto",
        }

    async def test_tool_calls_pass_through_and_key_stays_on_upstream(self):
        response = await self.client.post(
            "/api/agent/chat/completions",
            headers={"Authorization": "Bearer browser-placeholder", "Origin": "http://127.0.0.1:5173"},
            json=self.payload(),
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["choices"][0]["message"]["tool_calls"][0]["function"]["name"], "read_cards")
        self.assertIsNone(response.json()["choices"][0]["message"]["content"])
        self.assertNotIn("env-secret", response.text)
        self.assertNotIn("browser-placeholder", response.text)
        upstream = self.calls[-1]
        self.assertEqual(upstream.headers["authorization"], "Bearer env-secret")
        self.assertEqual(str(upstream.url), "https://models.example/v1/chat/completions")
        self.assertNotIn("api.vercel.com", str(upstream.url))
        forwarded = json.loads(upstream.content)
        self.assertEqual(forwarded["tools"][0]["function"]["name"], "read_cards")
        self.assertEqual(forwarded["tool_choice"], "auto")
        self.assertNotIn("api_key", forwarded)

    async def test_missing_key_and_upstream_errors_do_not_echo_secrets(self):
        self.store.settings = replace(self.settings, api_key="")
        missing = await self.client.post("/api/agent/chat/completions", json=self.payload())
        self.assertEqual(missing.status_code, 503)
        self.assertNotIn("env-secret", missing.text)
        self.assertEqual(self.calls, [])
        self.store.settings = self.settings
        self.upstream_status = 400
        rejected = await self.client.post(
            "/api/agent/chat/completions",
            headers={"Authorization": "Bearer env-secret"},
            json=self.payload(),
        )
        self.assertEqual(rejected.status_code, 400)
        self.assertNotIn("env-secret", rejected.text)
        self.assertIn("请求参数不被该模型支持", rejected.text)

    async def test_stream_forwards_tool_chunks_without_the_key(self):
        response = await self.client.post("/api/agent/chat/completions", json={**self.payload(), "stream": True})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("tool_calls", response.text)
        self.assertNotIn("env-secret", response.text)
        self.assertEqual(json.loads(self.calls[-1].content)["stream"], True)

    async def test_foreign_origin_is_rejected_before_upstream(self):
        response = await self.client.post(
            "/api/agent/chat/completions",
            headers={"Origin": "https://evil.example"},
            json=self.payload(),
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.calls, [])
