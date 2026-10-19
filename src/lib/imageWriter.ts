import { apiFetch } from "./apiClient";
import { modelRequest } from "./modelConfigs";
import type {
  ImageAspectRatio,
  ImageGenerationSettings,
  ImageResolution,
} from "../types";

type HealthResponse = {
  image_provider?: string;
  image_model?: string;
  image_models?: string[];
  image_configured?: boolean;
};

type ImageResponse = {
  images?: Array<{
    data_url?: string;
    asset_id?: string;
    url?: string;
    revised_prompt?: string;
  }>;
  model?: string;
  detail?: string;
  message?: string;
};

type ChatResponse = {
  text?: string;
  detail?: string;
  message?: string;
};

export type ImageReference = {
  id: string;
  kind: "text" | "image";
  label: string;
  text?: string;
  dataUrl?: string;
};

export type ImageReferenceOption = {
  id: string;
  kind: "text" | "image";
  label: string;
  assetUrl?: string;
};

export const DEFAULT_IMAGE_SETTINGS: ImageGenerationSettings = {
  model: "agnes-image-2.5-flash",
  aspectRatio: "adaptive",
  resolution: "1K",
  style: "自动风格",
  shot: "自动景别",
  angle: "自动视角",
  lens: "自动镜头",
  count: 1,
};

export const IMAGE_ASPECT_OPTIONS: Array<{
  value: ImageAspectRatio;
  label: string;
}> = [
  { value: "adaptive", label: "自适应" },
  { value: "1:1", label: "1:1" },
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
  { value: "4:3", label: "4:3" },
  { value: "3:4", label: "3:4" },
];

export const IMAGE_RESOLUTION_OPTIONS: ImageResolution[] = ["1K", "2K"];

export const IMAGE_STYLE_OPTIONS = [
  "自动风格",
  "电影感",
  "漫画分镜",
  "日系动漫",
  "国风水墨",
  "3D 动画",
  "写实摄影",
];

export const IMAGE_SHOT_OPTIONS = [
  "自动景别",
  "大特写",
  "特写",
  "中景",
  "全景",
  "远景",
];

export const IMAGE_ANGLE_OPTIONS = [
  "自动视角",
  "平视",
  "俯拍",
  "仰拍",
  "过肩",
  "荷兰角",
];

export const IMAGE_LENS_OPTIONS = [
  "自动镜头",
  "广角镜头",
  "标准镜头",
  "长焦镜头",
  "微距镜头",
  "鱼眼镜头",
];

async function responseError(response: Response) {
  const data = (await response.json().catch(() => null)) as
    | { detail?: string; message?: string }
    | null;
  return data?.detail || data?.message || `图片模型返回 ${response.status}`;
}

export async function readImageModelOptions() {
  const response = await apiFetch("/api/health");
  if (!response.ok) {
    throw new Error("无法读取图片模型");
  }

  const data = (await response.json()) as HealthResponse;
  const defaultModel =
    data.image_model?.trim() || DEFAULT_IMAGE_SETTINGS.model;
  const models = Array.from(
    new Set(
      [defaultModel, ...(data.image_models || [])]
        .map((model) => model.trim())
        .filter(Boolean),
    ),
  );

  return {
    defaultModel,
    models,
    provider: data.image_provider?.trim() || "Agnes AI",
    configured: Boolean(data.image_configured),
  };
}

export async function optimizeImagePrompt(prompt: string) {
  const response = await apiFetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system: `你是漫剧图片提示词优化助手。把用户的简短描述改成一段可直接用于图片生成的中文提示词。
只返回优化后的提示词，不要解释，不要标题，不要代码块。
保持用户的核心人物、动作、场景和风格，不擅自改变剧情。
补充有助于画面稳定的主体、环境、光线、构图和情绪细节，控制在 300 字以内。`,
      prompt: prompt.slice(0, 3000),
      ...modelRequest("text"),
    }),
  });
  const data = (await response.json().catch(() => null)) as ChatResponse | null;

  if (!response.ok || !data?.text?.trim()) {
    throw new Error(
      data?.detail || data?.message || `提示词优化返回 ${response.status}`,
    );
  }

  return data.text.trim();
}

export async function generateImages(
  prompt: string,
  settings: ImageGenerationSettings,
  references: ImageReference[],
) {
  const response = await apiFetch("/api/images/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      ...modelRequest("image", settings.model),
      aspect_ratio: settings.aspectRatio,
      resolution: settings.resolution,
      style: settings.style,
      shot: settings.shot,
      angle: settings.angle,
      lens: settings.lens,
      count: settings.count,
      references: references.map((reference) => ({
        kind: reference.kind,
        label: reference.label,
        content:
          reference.kind === "text"
            ? reference.text?.slice(0, 5000)
            : reference.dataUrl,
      })),
    }),
  });
  const data = (await response.json().catch(() => null)) as ImageResponse | null;

  if (!response.ok || !data?.images?.length) {
    throw new Error(
      data?.detail || data?.message || (await responseError(response)),
    );
  }

  const images = data.images
    .map((image) => ({
      dataUrl: image.data_url?.trim() || "",
      assetId: image.asset_id?.trim() || "",
      previewUrl: image.url?.trim() || "",
      revisedPrompt: image.revised_prompt?.trim(),
    }))
    .filter((image) => image.assetId || image.dataUrl.startsWith("data:image/"));

  if (!images.length) {
    throw new Error("图片模型没有返回可用图片");
  }

  return {
    images,
    model: data.model?.trim() || settings.model,
  };
}

export function dataUrlToFile(dataUrl: string, fileName: string) {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) {
    throw new Error("图片数据格式不正确");
  }

  const mimeType = match[1];
  const binary = window.atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new File([bytes], fileName, { type: mimeType });
}

export function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("无法读取参考图片"));
    reader.readAsDataURL(blob);
  });
}

export async function mediaUrlToDataUrl(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("无法读取参考图片");
  }
  return blobToDataUrl(await response.blob());
}
