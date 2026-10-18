from __future__ import annotations

import asyncio
import base64
import binascii
import os
from contextlib import asynccontextmanager
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Literal, Optional

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from urllib.parse import urlsplit, urlunsplit
from backend.model_configs import ConfigStore, ConfigInput, ConnectionInput
from pydantic import BaseModel, Field


PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")


def read_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    base_url: str
    api_key: str
    model: str
    models: tuple[str, ...]
    enable_thinking: bool
    timeout_seconds: float
    image_base_url: str
    image_api_key: str
    image_provider: str
    image_model: str
    image_models: tuple[str, ...]
    image_timeout_seconds: float
    video_base_url: str
    video_query_base_url: str
    video_api_key: str
    video_model: str
    video_models: tuple[str, ...]
    video_timeout_seconds: float

    @classmethod
    def from_environment(cls) -> "Settings":
        model = os.getenv("MJH_LLM_MODEL", "agnes-3.0-flash").strip()
        configured_models = tuple(
            dict.fromkeys(
                item.strip()
                for item in os.getenv(
                    "MJH_LLM_MODELS",
                    "agnes-3.0-flash,agnes-2.5-flash",
                ).split(",")
                if item.strip()
            )
        )
        models = (
            configured_models
            if model in configured_models
            else (model, *configured_models)
        )
        base_url = os.getenv(
            "MJH_LLM_BASE_URL",
            "https://apihub.agnes-ai.com/v1",
        ).rstrip("/")
        api_key = os.getenv("MJH_LLM_API_KEY", "").strip()
        image_model = os.getenv(
            "MJH_IMAGE_MODEL",
            "agnes-image-2.5-flash",
        ).strip()
        configured_image_models = tuple(
            dict.fromkeys(
                item.strip()
                for item in os.getenv(
                    "MJH_IMAGE_MODELS",
                    "agnes-image-2.5-flash,agnes-image-2.1-flash,agnes-image-2.0-flash",
                ).split(",")
                if item.strip()
            )
        )
        image_models = (
            configured_image_models
            if image_model in configured_image_models
            else (image_model, *configured_image_models)
        )
        video_model = os.getenv(
            "MJH_VIDEO_MODEL",
            "agnes-video-2.5-flash",
        ).strip()
        configured_video_models = tuple(
            dict.fromkeys(
                item.strip()
                for item in os.getenv(
                    "MJH_VIDEO_MODELS",
                    "agnes-video-2.5-flash",
                ).split(",")
                if item.strip()
            )
        )
        video_models = (
            configured_video_models
            if video_model in configured_video_models
            else (video_model, *configured_video_models)
        )
        return cls(
            base_url=base_url,
            api_key=api_key,
            model=model,
            models=models,
            enable_thinking=read_bool("MJH_LLM_ENABLE_THINKING"),
            timeout_seconds=float(os.getenv("MJH_LLM_TIMEOUT_SECONDS", "75")),
            image_base_url=os.getenv(
                "MJH_IMAGE_BASE_URL",
                base_url,
            ).rstrip("/"),
            image_api_key=os.getenv("MJH_IMAGE_API_KEY", api_key).strip(),
            image_provider=os.getenv(
                "MJH_IMAGE_PROVIDER",
                "agnes",
            ).strip().lower(),
            image_model=image_model,
            image_models=image_models,
            image_timeout_seconds=float(
                os.getenv("MJH_IMAGE_TIMEOUT_SECONDS", "180")
            ),
            video_base_url=os.getenv(
                "MJH_VIDEO_BASE_URL",
                base_url,
            ).rstrip("/"),
            video_query_base_url=os.getenv(
                "MJH_VIDEO_QUERY_BASE_URL",
                "https://apihub.agnes-ai.com",
            ).rstrip("/"),
            video_api_key=os.getenv("MJH_VIDEO_API_KEY", api_key).strip(),
            video_model=video_model,
            video_models=video_models,
            video_timeout_seconds=float(
                os.getenv("MJH_VIDEO_TIMEOUT_SECONDS", "420")
            ),
        )


settings = Settings.from_environment()
LOCAL_ORIGINS = [f"http://{host}:{port}" for host in ("127.0.0.1", "localhost") for port in {"5173", os.getenv("MJH_WEB_PORT", "5173")}]
config_store = ConfigStore(PROJECT_ROOT / '.local' / 'model-configs.json', settings)


def request_settings(kind: str, config_id: str | None, model: str | None):
    default = {'text': settings.model, 'image': settings.image_model, 'video': settings.video_model}[kind]
    entry = config_store.get(config_id or f'builtin:{kind}:{model or default}', kind)
    if not entry['api_key']:
        raise HTTPException(503, '未配置 API Key，请在模型管理中填写')
    selected = entry['model']
    if kind == 'text':
        result = replace(settings, base_url=entry['base_url'], api_key=entry['api_key'], model=selected, models=(selected,), enable_thinking=settings.enable_thinking if entry['builtin'] else False)
    elif kind == 'image':
        result = replace(settings, image_base_url=entry['base_url'], image_api_key=entry['api_key'], image_provider=entry['protocol'].split('-')[0], image_model=selected, image_models=(selected,))
    else:
        parsed = urlsplit(entry['base_url'])
        query = entry.get('query_base_url') or urlunsplit((parsed.scheme, parsed.netloc, '', '', ''))
        result = replace(settings, video_base_url=entry['base_url'], video_query_base_url=query, video_api_key=entry['api_key'], video_model=selected, video_models=(selected,))
    return result, selected, entry


def safe_provider_error(error: ProviderError) -> str:
    # Never echo provider bodies: some gateways include credentials in errors.
    return {400: '请求参数不被该模型支持', 401: 'API Key 无效', 403: '没有模型访问权限', 404: '模型或接口不存在', 413: '参考素材过大', 422: '模型参数不匹配', 429: '额度不足或请求过于频繁', 503: '模型服务暂时不可用', 504: '模型请求超时，请稍后重试'}.get(error.status_code, '模型服务连接失败或返回无效结果，请检查接口配置后重试')



class ChatRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=30_000)
    system: Optional[str] = Field(default=None, max_length=8_000)
    model: Optional[str] = Field(default=None, max_length=120)
    model_config_id: Optional[str] = Field(default=None, max_length=240)


class ChatResponse(BaseModel):
    text: str
    model: str
    provider: str = "Agnes AI"


class ImageReferenceRequest(BaseModel):
    kind: Literal["text", "image"]
    label: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=20_000_000)


class ImageGenerationRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=8_000)
    model: Optional[str] = Field(default=None, max_length=120)
    model_config_id: Optional[str] = Field(default=None, max_length=240)
    aspect_ratio: Literal[
        "adaptive",
        "1:1",
        "16:9",
        "9:16",
        "4:3",
        "3:4",
    ] = "adaptive"
    resolution: Literal["1K", "2K"] = "1K"
    style: str = Field(default="自动风格", max_length=120)
    shot: str = Field(default="自动景别", max_length=120)
    angle: str = Field(default="自动视角", max_length=120)
    lens: str = Field(default="自动镜头", max_length=120)
    count: int = Field(default=1, ge=1, le=4)
    references: list[ImageReferenceRequest] = Field(default_factory=list, max_length=5)


class GeneratedImage(BaseModel):
    data_url: str
    revised_prompt: Optional[str] = None


class ImageGenerationResponse(BaseModel):
    images: list[GeneratedImage]
    model: str
    provider: str


class VideoGenerationRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=8_000)
    model: Optional[str] = Field(default=None, max_length=120)
    model_config_id: Optional[str] = Field(default=None, max_length=240)
    aspect_ratio: Literal[
        "adaptive",
        "1:1",
        "16:9",
        "9:16",
        "4:3",
        "3:4",
    ] = "adaptive"
    duration: Literal[5, 10] = 5


class ProviderError(Exception):
    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.message = message


def provider_error_message(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        return response.text.strip()[:500] or "上游模型返回了未知错误"

    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
            return str(error.get("message") or error.get("detail") or error)[:500]
        return str(payload.get("message") or payload.get("detail") or payload)[:500]
    return str(payload)[:500]


def message_text(payload: dict[str, Any]) -> str:
    try:
        content = payload["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ProviderError(502, "上游模型没有返回可用文字") from exc

    if isinstance(content, str):
        return content.strip()

    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "\n".join(parts).strip()

    raise ProviderError(502, "上游模型返回了无法识别的文字格式")


def agnes_20_image_size(aspect_ratio: str, resolution: str) -> str:
    sizes = {
        "1K": {
            "adaptive": "auto",
            "1:1": "1024x1024",
            "16:9": "1792x1024",
            "9:16": "1024x1792",
            "4:3": "1365x1024",
            "3:4": "1024x1365",
        },
        "2K": {
            "adaptive": "2048x2048",
            "1:1": "2048x2048",
            "16:9": "3584x2048",
            "9:16": "2048x3584",
            "4:3": "2731x2048",
            "3:4": "2048x2731",
        },
    }
    return sizes[resolution][aspect_ratio]


def openai_image_size(aspect_ratio: str) -> str:
    if aspect_ratio == "adaptive":
        return "auto"
    if aspect_ratio in {"16:9", "4:3"}:
        return "1536x1024"
    if aspect_ratio in {"9:16", "3:4"}:
        return "1024x1536"
    return "1024x1024"


def image_provider_name(provider: str) -> str:
    names = {
        "agnes": "Agnes AI",
        "openai": "OpenAI",
    }
    return names.get(provider, provider)


# Agnes Video 2.5 and 2.5 Flash share the async /videos contract.
# Flash accepts only size "720P"; this app always requests 720P.
AGNES_VIDEO_25_MODELS = frozenset({"agnes-video-2.5", "agnes-video-2.5-flash"})


def video_size(aspect_ratio: str) -> tuple[int, int]:
    sizes = {
        "adaptive": (1152, 768),
        "1:1": (720, 720),
        "16:9": (1280, 720),
        "9:16": (720, 1280),
        "4:3": (960, 720),
        "3:4": (720, 960),
    }
    return sizes[aspect_ratio]


def compose_image_prompt(image_request: ImageGenerationRequest) -> str:
    parts = [image_request.prompt.strip()]
    controls = [
        value
        for value, automatic in (
            (image_request.style, "自动风格"),
            (image_request.shot, "自动景别"),
            (image_request.angle, "自动视角"),
            (image_request.lens, "自动镜头"),
        )
        if value and value != automatic
    ]
    if controls:
        parts.append(f"画面控制：{'，'.join(controls)}。")

    text_references = [
        reference
        for reference in image_request.references
        if reference.kind == "text"
    ]
    if text_references:
        reference_sections = "\n".join(
            f"[{reference.label}]\n{reference.content[:5000]}"
            for reference in text_references
        )
        parts.append(
            "以下文字仅用于约束人物、场景和剧情一致性，不要把说明文字画进图片：\n"
            f"{reference_sections}"
        )

    return "\n\n".join(parts)


def decode_reference_image(reference: ImageReferenceRequest) -> tuple[bytes, str]:
    try:
        header, encoded = reference.content.split(",", 1)
    except ValueError as exc:
        raise ProviderError(400, f"参考图片“{reference.label}”格式不正确") from exc

    if not header.startswith("data:image/") or ";base64" not in header:
        raise ProviderError(400, f"参考图片“{reference.label}”格式不正确")

    media_type = header[5:].split(";", 1)[0]
    try:
        content = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ProviderError(400, f"参考图片“{reference.label}”无法读取") from exc

    if len(content) > 12 * 1024 * 1024:
        raise ProviderError(400, f"参考图片“{reference.label}”不能超过 12MB")
    return content, media_type


async def image_data_url(
    client: httpx.AsyncClient,
    item: dict[str, Any],
) -> str:
    encoded = item.get("b64_json")
    if isinstance(encoded, str) and encoded:
        try:
            base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ProviderError(502, "图片模型返回了无效图片数据") from exc
        return f"data:image/png;base64,{encoded}"

    image_url = item.get("url")
    if not isinstance(image_url, str) or not image_url.startswith(("http://", "https://")):
        raise ProviderError(502, "图片模型没有返回可用图片")

    try:
        response = await client.get(image_url)
    except httpx.TimeoutException as exc:
        raise ProviderError(504, "下载生成图片超时，请稍后重试") from exc
    except httpx.HTTPError as exc:
        raise ProviderError(502, "无法下载图片模型的生成结果") from exc

    if response.is_error:
        raise ProviderError(502, "无法下载图片模型的生成结果")
    media_type = response.headers.get("content-type", "image/png").split(";", 1)[0]
    if not media_type.startswith("image/"):
        raise ProviderError(502, "图片模型返回的结果不是图片")
    encoded_image = base64.b64encode(response.content).decode("ascii")
    return f"data:{media_type};base64,{encoded_image}"


async def generated_images_from_response(
    client: httpx.AsyncClient,
    response: httpx.Response,
    count: int,
) -> list[GeneratedImage]:
    if response.is_error:
        raise ProviderError(
            response.status_code,
            provider_error_message(response),
        )

    try:
        payload = response.json()
    except ValueError as exc:
        raise ProviderError(502, "图片模型返回了无效数据") from exc

    raw_images = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(raw_images, list) or not raw_images:
        raise ProviderError(502, "图片模型没有返回生成结果")

    generated_images = []
    for item in raw_images[:count]:
        if not isinstance(item, dict):
            continue
        generated_images.append(
            GeneratedImage(
                data_url=await image_data_url(client, item),
                revised_prompt=(
                    str(item["revised_prompt"])[:8000]
                    if item.get("revised_prompt")
                    else None
                ),
            )
        )

    if not generated_images:
        raise ProviderError(502, "图片模型没有返回可用图片")
    return generated_images


def image_references(
    image_request: ImageGenerationRequest,
) -> list[ImageReferenceRequest]:
    references = [
        reference
        for reference in image_request.references
        if reference.kind == "image"
    ][:3]
    for reference in references:
        decode_reference_image(reference)
    return references


async def call_agnes_image_model(
    client: httpx.AsyncClient,
    model: str,
    image_request: ImageGenerationRequest,
    config: Settings | None = None,
) -> list[GeneratedImage]:
    cfg = config or settings
    references = image_references(image_request)
    payload: dict[str, Any] = {
        "model": model,
        "prompt": compose_image_prompt(image_request),
        "n": image_request.count,
        "extra_body": {
            "response_format": "b64_json",
        },
    }
    if references:
        payload["extra_body"]["image"] = [
            reference.content for reference in references
        ]

    if model == "agnes-image-2.0-flash":
        payload["size"] = agnes_20_image_size(
            image_request.aspect_ratio,
            image_request.resolution,
        )
    else:
        # 2.1 Flash and 2.5 Flash share this contract: tier size + ratio,
        # reference images in extra_body.image, and return_base64 for text-to-image.
        payload["size"] = image_request.resolution
        if image_request.aspect_ratio != "adaptive":
            payload["ratio"] = image_request.aspect_ratio
        if not references:
            payload["return_base64"] = True

    try:
        response = await client.post(
            f"{cfg.image_base_url}/images/generations",
            headers={
                "Authorization": f"Bearer {cfg.image_api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=httpx.Timeout(
                cfg.image_timeout_seconds,
                connect=15,
            ),
        )
    except httpx.TimeoutException as exc:
        raise ProviderError(504, "图片生成超时，请稍后重试") from exc
    except httpx.HTTPError as exc:
        raise ProviderError(502, "无法连接 Agnes AI 图片服务") from exc

    return await generated_images_from_response(
        client,
        response,
        image_request.count,
    )


async def call_openai_image_model(
    client: httpx.AsyncClient,
    model: str,
    image_request: ImageGenerationRequest,
    config: Settings | None = None,
) -> list[GeneratedImage]:
    cfg = config or settings
    references = image_references(image_request)
    headers = {"Authorization": f"Bearer {cfg.image_api_key}"}

    try:
        if references:
            files: list[tuple[str, tuple[str, bytes, str]]] = []
            for index, reference in enumerate(references, start=1):
                content, media_type = decode_reference_image(reference)
                extension = media_type.split("/", 1)[-1].replace("jpeg", "jpg")
                files.append(
                    (
                        "image",
                        (f"reference-{index}.{extension}", content, media_type),
                    )
                )
            response = await client.post(
                f"{cfg.image_base_url}/images/edits",
                headers=headers,
                data={
                    "model": model,
                    "prompt": compose_image_prompt(image_request),
                    "n": str(image_request.count),
                    "size": openai_image_size(image_request.aspect_ratio),
                },
                files=files,
                timeout=httpx.Timeout(
                    cfg.image_timeout_seconds,
                    connect=15,
                ),
            )
        else:
            response = await client.post(
                f"{cfg.image_base_url}/images/generations",
                headers={**headers, "Content-Type": "application/json"},
                json={
                    "model": model,
                    "prompt": compose_image_prompt(image_request),
                    "n": image_request.count,
                    "size": openai_image_size(image_request.aspect_ratio),
                },
                timeout=httpx.Timeout(
                    cfg.image_timeout_seconds,
                    connect=15,
                ),
            )
    except httpx.TimeoutException as exc:
        raise ProviderError(504, "图片生成超时，请稍后重试") from exc
    except httpx.HTTPError as exc:
        raise ProviderError(502, "无法连接 OpenAI 图片服务") from exc

    return await generated_images_from_response(
        client,
        response,
        image_request.count,
    )


async def call_image_model(
    client: httpx.AsyncClient,
    model: str,
    image_request: ImageGenerationRequest,
    config: Settings | None = None,
) -> list[GeneratedImage]:
    cfg = config or settings
    adapters = {
        "agnes": call_agnes_image_model,
        "openai": call_openai_image_model,
    }
    adapter = adapters.get(cfg.image_provider)
    if adapter is None:
        raise ProviderError(
            503,
            f"不支持的图片服务类型：{cfg.image_provider}",
        )
    return await adapter(client, model, image_request, cfg)


async def call_video_model(
    client: httpx.AsyncClient,
    model: str,
    video_request: VideoGenerationRequest,
    config: Settings | None = None,
) -> tuple[bytes, str, str, str]:
    cfg = config or settings
    width, height = video_size(video_request.aspect_ratio)
    headers = {
        "Authorization": f"Bearer {cfg.video_api_key}",
        "Content-Type": "application/json",
    }
    if model in AGNES_VIDEO_25_MODELS:
        create_payload: dict[str, Any] = {
            "model": model,
            "prompt": video_request.prompt.strip(),
            "seconds": str(video_request.duration),
            "mode": "text",
            "size": "720P",
            "aspect_ratio": "16:9" if video_request.aspect_ratio == "adaptive" else video_request.aspect_ratio,
        }
    else:
        create_payload = {
            "model": model,
            "prompt": video_request.prompt.strip(),
            "width": width,
            "height": height,
            "num_frames": video_request.duration * 24 + 1,
            "frame_rate": 24,
        }

    try:
        create_response = await client.post(
            f"{cfg.video_base_url}/videos",
            headers=headers,
            json=create_payload,
            timeout=httpx.Timeout(60, connect=15),
        )
    except httpx.TimeoutException as exc:
        raise ProviderError(504, "创建视频任务超时，请稍后重试") from exc
    except httpx.HTTPError as exc:
        raise ProviderError(502, "无法连接 Agnes AI 视频服务") from exc

    if create_response.is_error:
        raise ProviderError(
            create_response.status_code,
            provider_error_message(create_response),
        )

    try:
        task = create_response.json()
    except ValueError as exc:
        raise ProviderError(502, "视频模型返回了无效任务数据") from exc

    video_id = task.get("video_id") if isinstance(task, dict) else None
    if not isinstance(video_id, str) or not video_id:
        raise ProviderError(502, "视频模型没有返回 video_id")

    deadline = (
        asyncio.get_running_loop().time() + cfg.video_timeout_seconds
    )
    result: dict[str, Any] | None = None
    while asyncio.get_running_loop().time() < deadline:
        try:
            status_response = await client.get(
                f"{cfg.video_query_base_url}/agnesapi",
                headers={"Authorization": f"Bearer {cfg.video_api_key}"},
                params={"video_id": video_id, "model_name": model},
                timeout=httpx.Timeout(30, connect=15),
            )
        except httpx.TimeoutException:
            await asyncio.sleep(3)
            continue
        except httpx.HTTPError as exc:
            raise ProviderError(502, "无法查询 Agnes AI 视频任务") from exc

        if status_response.is_error:
            if status_response.status_code in {429, 500, 502, 503}:
                await asyncio.sleep(3)
                continue
            raise ProviderError(
                status_response.status_code,
                provider_error_message(status_response),
            )

        try:
            payload = status_response.json()
        except ValueError as exc:
            raise ProviderError(502, "视频模型返回了无效状态数据") from exc

        if not isinstance(payload, dict):
            raise ProviderError(502, "视频模型返回了无效状态数据")

        status = str(payload.get("status") or "").lower()
        if status == "completed":
            result = payload
            break
        if status == "failed":
            error = payload.get("error")
            message = (
                str(error.get("message") or error)
                if isinstance(error, dict)
                else str(error or "视频生成失败")
            )
            raise ProviderError(502, message[:500])
        await asyncio.sleep(3)

    if result is None:
        raise ProviderError(504, "视频生成等待超时，请稍后重试")

    video_url = result.get("url")
    if not isinstance(video_url, str) or not video_url.startswith(("http://", "https://")):
        metadata = result.get("metadata")
        video_url = metadata.get("url") if isinstance(metadata, dict) else None
    if not isinstance(video_url, str) or not video_url.startswith(
        ("http://", "https://")
    ):
        raise ProviderError(502, "视频模型没有返回可用视频")

    try:
        download_response = await client.get(
            video_url,
            timeout=httpx.Timeout(120, connect=15),
        )
    except httpx.TimeoutException as exc:
        raise ProviderError(504, "下载生成视频超时，请稍后重试") from exc
    except httpx.HTTPError as exc:
        raise ProviderError(502, "无法下载视频模型的生成结果") from exc

    if download_response.is_error:
        raise ProviderError(502, "无法下载视频模型的生成结果")

    media_type = download_response.headers.get(
        "content-type",
        "video/mp4",
    ).split(";", 1)[0]
    if not media_type.startswith("video/"):
        raise ProviderError(502, "视频模型返回的结果不是视频")

    seconds = str(result.get("seconds") or video_request.duration)
    size = str(result.get("size") or f"{width}x{height}")
    return download_response.content, media_type, seconds, size


async def call_agnes(
    client: httpx.AsyncClient,
    model: str,
    chat_request: ChatRequest,
    config: Settings | None = None,
) -> str:
    cfg = config or settings
    messages: list[dict[str, str]] = []
    if chat_request.system:
        messages.append({"role": "system", "content": chat_request.system})
    messages.append({"role": "user", "content": chat_request.prompt})

    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "stream": False,
    }
    if cfg.enable_thinking:
        payload["chat_template_kwargs"] = {"enable_thinking": True}

    try:
        response = await client.post(
            f"{cfg.base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {cfg.api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
        )
    except httpx.TimeoutException as exc:
        raise ProviderError(504, "文字模型请求超时，请稍后重试") from exc
    except httpx.HTTPError as exc:
        raise ProviderError(502, "无法连接文字模型服务") from exc

    if response.is_error:
        raise ProviderError(
            response.status_code,
            provider_error_message(response),
        )

    try:
        data = response.json()
    except ValueError as exc:
        raise ProviderError(502, "上游模型返回了无效数据") from exc

    text = message_text(data)
    if not text:
        raise ProviderError(502, "上游模型返回了空文字")
    return text


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.http_client = httpx.AsyncClient(
        timeout=httpx.Timeout(settings.timeout_seconds, connect=10),
    )
    yield
    await app.state.http_client.aclose()


app = FastAPI(
    title="漫金海 API",
    version="0.1.0",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=LOCAL_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)


@app.get("/api/health")
async def health() -> dict[str, Any]:
    entries = config_store.all()
    defaults = {'text': settings.model, 'image': settings.image_model, 'video': settings.video_model}
    result: dict[str, Any] = {'status': 'ok', 'project': '漫金海'}
    for kind, model in defaults.items():
        prefix = '' if kind == 'text' else kind + '_'
        entry = next(c for c in entries if c['id'] == f'builtin:{kind}:{model}')
        result.update({prefix + 'model': model,
                       prefix + 'models': [c['model'] for c in entries if c['kind'] == kind and c['builtin']],
                       prefix + 'configured': bool(entry['api_key']),
                       prefix + 'provider': 'Agnes AI' if entry['model'].startswith('agnes-') else entry['protocol']})
    return result


@app.post("/api/chat", response_model=ChatResponse)
async def chat(chat_request: ChatRequest, request: Request) -> ChatResponse:
    config, selected_model, entry = request_settings("text", chat_request.model_config_id, chat_request.model)

    client: httpx.AsyncClient = request.app.state.http_client
    try:
        text = await call_agnes(client, selected_model, chat_request, config)
        return ChatResponse(text=text, model=selected_model, provider=entry["name"])
    except ProviderError as provider_error:
        status_code = (
            provider_error.status_code
            if provider_error.status_code
            in {400, 401, 403, 404, 429, 502, 503, 504}
            else 502
        )
        raise HTTPException(
            status_code=status_code,
            detail=f"{selected_model} 调用失败：{safe_provider_error(provider_error)}",
        ) from provider_error


@app.post("/api/videos/generate")
async def generate_video(
    video_request: VideoGenerationRequest,
    request: Request,
) -> Response:
    config, selected_model, entry = request_settings("video", video_request.model_config_id, video_request.model)

    client: httpx.AsyncClient = request.app.state.http_client
    try:
        content, media_type, seconds, size = await call_video_model(
            client,
            selected_model,
            video_request,
            config,
        )
        return Response(
            content=content,
            media_type=media_type,
            headers={
                "X-MJH-Video-Model": selected_model,
                "X-MJH-Video-Seconds": seconds,
                "X-MJH-Video-Size": size,
                "Content-Disposition": 'inline; filename="manjinhai-video.mp4"',
            },
        )
    except ProviderError as provider_error:
        status_code = (
            provider_error.status_code
            if provider_error.status_code
            in {400, 401, 403, 404, 413, 422, 429, 502, 503, 504}
            else 502
        )
        raise HTTPException(
            status_code=status_code,
            detail=f"{selected_model} 调用失败：{safe_provider_error(provider_error)}",
        ) from provider_error


@app.post("/api/images/generate", response_model=ImageGenerationResponse)
async def generate_image(
    image_request: ImageGenerationRequest,
    request: Request,
) -> ImageGenerationResponse:
    config, selected_model, entry = request_settings("image", image_request.model_config_id, image_request.model)

    client: httpx.AsyncClient = request.app.state.http_client
    try:
        images = await call_image_model(client, selected_model, image_request, config)
        return ImageGenerationResponse(
            images=images,
            model=selected_model,
            provider=image_provider_name(config.image_provider),
        )
    except ProviderError as provider_error:
        status_code = (
            provider_error.status_code
            if provider_error.status_code
            in {400, 401, 403, 404, 413, 422, 429, 502, 503, 504}
            else 502
        )
        raise HTTPException(
            status_code=status_code,
            detail=f"{selected_model} 调用失败：{safe_provider_error(provider_error)}",
        ) from provider_error


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    # Pydantic's default error payload includes the rejected input, including keys.
    return JSONResponse(status_code=422, content={'detail': '配置或请求格式无效，请检查必填字段、API 地址和接口类型'})


@app.middleware('http')
async def protect_local_config(request: Request, call_next):
    if request.url.path.startswith('/api/model-configs'):
        origin = request.headers.get('origin')
        if origin and origin not in (*LOCAL_ORIGINS, str(request.base_url).rstrip('/')):
            return JSONResponse(status_code=403, content={'detail': '仅允许本机应用访问模型配置'})
        if request.method in ('POST', 'PUT') and 'application/json' not in request.headers.get('content-type', ''):
            return JSONResponse(status_code=415, content={'detail': '请使用 JSON 请求'})
    response = await call_next(request)
    if request.url.path.startswith('/api/model-configs'):
        response.headers['Cache-Control'] = 'no-store'
    return response


@app.get('/api/model-configs')
async def list_model_configs():
    connection = config_store.connection()
    return {'configs': [config_store.public(c) for c in config_store.all()],
            'agnes': {'base_url': connection['base_url'], 'configured': bool(connection['api_key'])},
            'defaults': {'text': settings.model, 'image': settings.image_model, 'video': settings.video_model}}


@app.put('/api/model-configs/agnes')
async def save_agnes_connection(value: ConnectionInput):
    config_store.save_connection(value)
    return {'saved': True}


@app.post('/api/model-configs')
async def create_model_config(value: ConfigInput):
    return config_store.save(value)


@app.put('/api/model-configs/{config_id}')
async def update_model_config(config_id: str, value: ConfigInput):
    return config_store.save(value, config_id)


@app.delete('/api/model-configs/{config_id}')
async def delete_model_config(config_id: str):
    config_store.delete(config_id)
    return {'deleted': True}


@app.post('/api/model-configs/{config_id}/test')
async def test_model_connection(config_id: str, request: Request):
    entry = config_store.get(config_id)
    if not entry['api_key']:
        return {'status': 'unconfigured', 'message': '未配置 API Key'}
    try:
        response = await request.app.state.http_client.get(
            entry['base_url'] + '/models',
            headers={'Authorization': 'Bearer ' + entry['api_key']},
            timeout=httpx.Timeout(12, connect=5),
        )
    except httpx.TimeoutException:
        return {'status': 'error', 'message': '连接超时，请检查地址后重试'}
    except httpx.HTTPError:
        return {'status': 'error', 'message': '无法连接上游服务，请检查 API 地址'}
    if response.status_code in (401, 403, 429):
        return {'status': 'error', 'message': safe_provider_error(ProviderError(response.status_code, ''))}
    if response.status_code >= 500:
        return {'status': 'error', 'message': '上游服务暂时不可用'}
    try:
        data = response.json().get('data', [])
        found = any(isinstance(item, dict) and item.get('id') == entry['model'] for item in data)
    except (ValueError, AttributeError, TypeError):
        found = False
    if response.is_success and found:
        return {'status': 'reachable', 'message': '模型目录可达且包含该模型；生成能力尚未验证'}
    return {'status': 'unverified', 'message': '已保存，生成时验证（服务未提供可确认的模型目录）'}
