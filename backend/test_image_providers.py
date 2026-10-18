from __future__ import annotations

from dataclasses import replace
from typing import Any
from unittest import IsolatedAsyncioTestCase
from unittest.mock import patch

import httpx

import backend.app as backend_app


REFERENCE_DATA_URL = "data:image/png;base64,aGVsbG8="
RESULT_BASE64 = "aW1hZ2U="


class FakeImageClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def post(self, url: str, **kwargs: Any) -> httpx.Response:
        self.calls.append((url, kwargs))
        return httpx.Response(
            200,
            json={"data": [{"b64_json": RESULT_BASE64}]},
            request=httpx.Request("POST", url),
        )

    async def get(self, url: str, **kwargs: Any) -> httpx.Response:
        raise AssertionError(f"测试不应下载远程图片：{url}")


def image_request() -> backend_app.ImageGenerationRequest:
    return backend_app.ImageGenerationRequest(
        prompt="保持人物一致，改成雨夜街景",
        aspect_ratio="16:9",
        resolution="1K",
        references=[
            backend_app.ImageReferenceRequest(
                kind="image",
                label="人物参考图",
                content=REFERENCE_DATA_URL,
            )
        ],
    )


class ImageProviderAdapterTests(IsolatedAsyncioTestCase):
    async def test_agnes_21_uses_json_generations_with_extra_body_image(
        self,
    ) -> None:
        client = FakeImageClient()
        configured = replace(backend_app.settings, image_provider="agnes")

        with patch.object(backend_app, "settings", configured):
            images = await backend_app.call_image_model(
                client,
                "agnes-image-2.1-flash",
                image_request(),
            )

        url, kwargs = client.calls[0]
        self.assertTrue(url.endswith("/images/generations"))
        self.assertNotIn("files", kwargs)
        self.assertNotIn("data", kwargs)
        self.assertEqual(kwargs["json"]["size"], "1K")
        self.assertEqual(kwargs["json"]["ratio"], "16:9")
        self.assertEqual(
            kwargs["json"]["extra_body"],
            {
                "response_format": "b64_json",
                "image": [REFERENCE_DATA_URL],
            },
        )
        self.assertEqual(
            images[0].data_url,
            f"data:image/png;base64,{RESULT_BASE64}",
        )
        self.assertNotIn("return_base64", kwargs["json"])

    async def test_agnes_25_reference_matches_21_contract(self) -> None:
        client = FakeImageClient()
        configured = replace(backend_app.settings, image_provider="agnes")

        with patch.object(backend_app, "settings", configured):
            await backend_app.call_image_model(
                client,
                "agnes-image-2.5-flash",
                image_request(),
            )

        url, kwargs = client.calls[0]
        self.assertTrue(url.endswith("/images/generations"))
        self.assertEqual(kwargs["json"]["model"], "agnes-image-2.5-flash")
        self.assertEqual(kwargs["json"]["size"], "1K")
        self.assertEqual(kwargs["json"]["ratio"], "16:9")
        self.assertEqual(
            kwargs["json"]["extra_body"],
            {
                "response_format": "b64_json",
                "image": [REFERENCE_DATA_URL],
            },
        )
        self.assertNotIn("return_base64", kwargs["json"])

    async def test_agnes_25_text_to_image_requests_return_base64(self) -> None:
        client = FakeImageClient()
        configured = replace(backend_app.settings, image_provider="agnes")
        request = backend_app.ImageGenerationRequest(
            prompt="雨夜街景",
            aspect_ratio="16:9",
            resolution="2K",
        )

        with patch.object(backend_app, "settings", configured):
            await backend_app.call_image_model(
                client,
                "agnes-image-2.5-flash",
                request,
            )

        _, kwargs = client.calls[0]
        self.assertEqual(kwargs["json"]["size"], "2K")
        self.assertEqual(kwargs["json"]["ratio"], "16:9")
        self.assertIs(kwargs["json"]["return_base64"], True)
        self.assertEqual(kwargs["json"]["extra_body"], {"response_format": "b64_json"})

    async def test_agnes_20_also_uses_json_generations(self) -> None:
        client = FakeImageClient()
        configured = replace(backend_app.settings, image_provider="agnes")

        with patch.object(backend_app, "settings", configured):
            await backend_app.call_image_model(
                client,
                "agnes-image-2.0-flash",
                image_request(),
            )

        url, kwargs = client.calls[0]
        self.assertTrue(url.endswith("/images/generations"))
        self.assertEqual(kwargs["json"]["size"], "1792x1024")
        self.assertEqual(
            kwargs["json"]["extra_body"]["image"],
            [REFERENCE_DATA_URL],
        )

    async def test_openai_adapter_keeps_multipart_edits(self) -> None:
        client = FakeImageClient()
        configured = replace(backend_app.settings, image_provider="openai")

        with patch.object(backend_app, "settings", configured):
            await backend_app.call_image_model(
                client,
                "gpt-image-1",
                image_request(),
            )

        url, kwargs = client.calls[0]
        self.assertTrue(url.endswith("/images/edits"))
        self.assertIn("files", kwargs)
        self.assertEqual(kwargs["data"]["size"], "1536x1024")
