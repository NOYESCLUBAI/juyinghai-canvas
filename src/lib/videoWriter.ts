import { apiFetch, resolveApiUrl } from "./apiClient";
import { modelRequest } from "./modelConfigs";
import type {
  VideoAspectRatio,
  VideoGenerationSettings,
} from "../types";

type HealthResponse = {
  video_provider?: string;
  video_model?: string;
  video_models?: string[];
  video_configured?: boolean;
};

type ErrorResponse = {
  detail?: string;
  message?: string;
};

type ChatResponse = ErrorResponse & {
  text?: string;
};

export const DEFAULT_VIDEO_SETTINGS: VideoGenerationSettings = {
  model: "agnes-video-2.5-flash",
  aspectRatio: "adaptive",
  resolution: "720p",
  duration: 5,
};

export const VIDEO_ASPECT_OPTIONS: Array<{
  value: VideoAspectRatio;
  label: string;
}> = [
  { value: "adaptive", label: "自适应" },
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
  { value: "1:1", label: "1:1" },
  { value: "4:3", label: "4:3" },
  { value: "3:4", label: "3:4" },
];

async function readError(response: Response) {
  const data = (await response.json().catch(() => null)) as ErrorResponse | null;
  return data?.detail || data?.message || `视频模型返回 ${response.status}`;
}

export async function readVideoModelOptions() {
  const response = await apiFetch("/api/health");
  if (!response.ok) {
    throw new Error("无法读取视频模型");
  }

  const data = (await response.json()) as HealthResponse;
  const defaultModel =
    data.video_model?.trim() || DEFAULT_VIDEO_SETTINGS.model;
  const models = Array.from(
    new Set(
      [defaultModel, ...(data.video_models || [])]
        .map((model) => model.trim())
        .filter(Boolean),
    ),
  );

  return {
    defaultModel,
    models,
    provider: data.video_provider?.trim() || "Agnes AI",
    configured: Boolean(data.video_configured),
  };
}

export async function optimizeVideoPrompt(prompt: string) {
  const response = await apiFetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system: `你是漫剧视频提示词优化助手。把用户的简短描述改成可直接用于视频生成的中文提示词。
只返回优化后的提示词，不要解释，不要标题，不要代码块。
保持核心人物、剧情和风格，补充主体动作、环境变化、镜头运动、光线和节奏。
强调动作连续、人物外观稳定，控制在 300 字以内。`,
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

export class VideoCancelled extends Error {}

let activeAbort: AbortController | null = null;
let activeJobId: string | null = null;

export function cancelActiveVideo() {
  const jobId = activeJobId;
  const current = activeAbort;
  activeAbort = null;
  activeJobId = null;
  current?.abort();
  if (jobId) {
    void apiFetch(`/api/video-jobs/${jobId}/cancel`, { method: "POST" }).catch(() => undefined);
  }
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new VideoCancelled("已停止等待。已提交的视频可能仍会计费。"));
    }, { once: true });
  });
}

async function pollVideoJob(jobId: string, signal: AbortSignal, settings: VideoGenerationSettings) {
  const started = Date.now();
  while (Date.now() - started < 15 * 60 * 1000) {
    if (signal.aborted) throw new VideoCancelled("已停止等待。已提交的视频可能仍会计费。");
    const response = await apiFetch(`/api/video-jobs/${jobId}`, { signal });
    const job = (await response.json().catch(() => null)) as {
      status?: string; error?: string; notice?: string; asset_id?: string; url?: string;
      model?: string; seconds?: string; size?: string; detail?: string;
    } | null;
    if (!response.ok || !job) throw new Error(job?.detail || "视频任务查询失败");
    if (job.status === "cancelled") throw new VideoCancelled(job.notice || "已停止等待。已提交的视频可能仍会计费。");
    if (job.status === "failed") throw new Error(job.error || "视频生成失败");
    if (job.status === "completed" && job.asset_id && job.url) {
      const previewUrl = resolveApiUrl(job.url);
      const file = await fetch(previewUrl);
      if (!file.ok) throw new Error("视频结果读取失败");
      const blob = await file.blob();
      return {
        blob,
        assetId: job.asset_id,
        previewUrl,
        model: job.model || settings.model,
        seconds: Number(job.seconds) || settings.duration,
        size: job.size || "",
      };
    }
    await delay(2000, signal);
  }
  throw new Error("视频生成等待超时，请稍后重试");
}

export async function generateVideo(
  prompt: string,
  settings: VideoGenerationSettings,
) {
  const controller = new AbortController();
  activeAbort = controller;
  activeJobId = null;
  try {
    const response = await apiFetch("/api/videos/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        ...modelRequest("video", settings.model),
        aspect_ratio: settings.aspectRatio,
        duration: settings.duration,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(await readError(response));
    }

    const type = response.headers.get("content-type") || "";
    if (type.includes("application/json")) {
      const job = (await response.json().catch(() => null)) as { job_id?: string; detail?: string } | null;
      if (!job?.job_id) throw new Error(job?.detail || "视频任务没有创建");
      activeJobId = job.job_id;
      return await pollVideoJob(job.job_id, controller.signal, settings);
    }

    const blob = await response.blob();
    if (!blob.type.startsWith("video/") || !blob.size) {
      throw new Error("视频模型没有返回可用视频");
    }

    return {
      blob,
      assetId: "",
      previewUrl: "",
      model: response.headers.get("X-MJH-Video-Model") || settings.model,
      seconds:
        Number(response.headers.get("X-MJH-Video-Seconds")) || settings.duration,
      size: response.headers.get("X-MJH-Video-Size") || "",
    };
  } catch (error) {
    if (controller.signal.aborted) throw new VideoCancelled("已停止等待。已提交的视频可能仍会计费。");
    throw error;
  } finally {
    if (activeAbort === controller) {
      activeAbort = null;
      activeJobId = null;
    }
  }
}
