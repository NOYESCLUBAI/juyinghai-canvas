import { ChoicePopover } from "./ChoicePopover";
import { modelLabel } from "../lib/modelConfigs";
import {
  ArrowUp,
  Clapperboard,
  LoaderCircle,
  RotateCcw,
  SlidersHorizontal,
  Cpu,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { VIDEO_ASPECT_OPTIONS } from "../lib/videoWriter";
import type { VideoGenerationSettings } from "../types";

type VideoWriterDockProps = {
  prompt: string;
  settings: VideoGenerationSettings;
  modelOptions: string[];
  busy: boolean;
  optimizing: boolean;
  configured: boolean;
  focusVersion: number;
  feedback?: {
    type: "success" | "error";
    text: string;
  };
  canUndo: boolean;
  onPromptChange: (prompt: string) => void;
  onSettingsChange: (settings: VideoGenerationSettings) => void;
  onOptimize: () => void;
  onSubmit: () => void;
  onUndo: () => void;
  onCancel?: () => void;
};

export function VideoWriterDock({
  prompt,
  settings,
  modelOptions,
  busy,
  optimizing,
  configured,
  focusVersion,
  feedback,
  canUndo,
  onPromptChange,
  onSettingsChange,
  onOptimize,
  onSubmit,
  onUndo,
  onCancel,
}: VideoWriterDockProps) {
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const availableModelOptions = useMemo(
    () => Array.from(new Set([settings.model, ...modelOptions])).filter(Boolean),
    [modelOptions, settings.model],
  );

  useEffect(() => {
    if (focusVersion > 0) {
      promptRef.current?.focus();
    }
  }, [focusVersion]);

  const setSetting = <Key extends keyof VideoGenerationSettings>(
    key: Key,
    value: VideoGenerationSettings[Key],
  ) => {
    onSettingsChange({ ...settings, [key]: value });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onSubmit();
    }
  };

  return (
    <form className="video-writer-dock" onSubmit={submit}>
      <div className="video-writer-context">
        <span className="video-writer-card-icon">
          <Clapperboard size={15} strokeWidth={1.75} />
        </span>
        <span>生成当前视频卡片</span>
        {feedback ? (
          <span className={`video-writer-feedback is-${feedback.type}`}>
            {feedback.text}
          </span>
        ) : !configured ? (
          <span className="video-writer-feedback is-error">
            视频模型尚未配置
          </span>
        ) : null}
      </div>

      <div className="video-writer-tools">
        <button
          className="video-prompt-optimize"
          type="button"
          title="优化视频提示词"
          aria-label="优化视频提示词"
          disabled={!prompt.trim() || busy || optimizing}
          onClick={onOptimize}
        >
          {optimizing ? (
            <LoaderCircle className="agent-spinner" size={15} strokeWidth={2} />
          ) : (
            <SlidersHorizontal size={15} strokeWidth={1.8} />
          )}
        </button>
      </div>

      <textarea
        ref={promptRef}
        value={prompt}
        aria-label="视频生成提示词"
        placeholder="描述主体动作、场景变化和镜头运动……"
        disabled={busy}
        onChange={(event) => onPromptChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />

      <footer className="video-writer-footer">
        <div className="video-writer-controls">
          <div className="video-control video-model-control">
            <Cpu size={14} strokeWidth={1.8} />
            <span className="visually-hidden">视频模型</span>
            <ChoicePopover
              aria-label="视频生成模型"
              value={settings.model}
              disabled={busy}
              onChange={(event) => setSetting("model", event.target.value)}
            >
              <option value="" disabled>请选择模型</option>
              {availableModelOptions.map((model) => (
                <option key={model} value={model}>
                  {modelLabel(model)}
                </option>
              ))}
            </ChoicePopover>
          </div>

          <div className="video-control">
            <SlidersHorizontal size={13} strokeWidth={1.8} />
            <span className="visually-hidden">视频比例</span>
            <ChoicePopover
              aria-label="视频比例"
              value={settings.aspectRatio}
              disabled={busy}
              onChange={(event) =>
                setSetting(
                  "aspectRatio",
                  event.target.value as VideoGenerationSettings["aspectRatio"],
                )
              }
            >
              {VIDEO_ASPECT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </ChoicePopover>
          </div>

          <span className="video-control-summary">· 720p</span>

          <div className="video-control">
            <span className="visually-hidden">视频时长</span>
            <ChoicePopover
              aria-label="视频时长"
              value={settings.duration}
              disabled={busy}
              onChange={(event) =>
                setSetting(
                  "duration",
                  Number(event.target.value) as VideoGenerationSettings["duration"],
                )
              }
            >
              <option value={5}>5s</option>
              <option value={10}>10s</option>
            </ChoicePopover>
          </div>
        </div>

        <div className="video-writer-actions">
          {canUndo ? (
            <button
              className="video-writer-undo"
              type="button"
              disabled={busy}
              onClick={onUndo}
            >
              <RotateCcw size={13} strokeWidth={1.8} />
              撤销生成
            </button>
          ) : null}
          {onCancel && busy ? (
            <button className="video-writer-undo" type="button" onClick={onCancel}>
              停止等待
            </button>
          ) : null}
          <span className="video-writer-shortcut">⌘ Enter</span>
          <button
            className="video-writer-submit"
            type="submit"
            aria-label="生成视频"
            title="生成视频"
            disabled={!prompt.trim() || busy || !configured}
          >
            {busy ? (
              <LoaderCircle className="agent-spinner" size={17} strokeWidth={2} />
            ) : (
              <ArrowUp size={17} strokeWidth={2} />
            )}
          </button>
        </div>
      </footer>
      {onCancel ? <p className="video-billing-note">停止后，已提交的视频可能仍会计费。</p> : null}
    </form>
  );
}
