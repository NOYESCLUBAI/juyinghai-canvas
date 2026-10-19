import {
  Clapperboard,
  Copy,
  Download,
  FileText,
  ImagePlus,
  Maximize2,
  X,
  LoaderCircle,
  Plus,
  Replace,
  RotateCcw,
  Trash2,
  Upload,
} from "lucide-react";
import {
  Handle,
  NodeResizer,
  NodeToolbar,
  Position,
  type NodeProps,
} from "@xyflow/react";
import {
  createContext,
  useContext,
  useRef,
  useState,
  useEffect,
  type ChangeEvent,
} from "react";
import { createPortal } from "react-dom";
import type {
  CanvasCardData,
  CanvasNode,
  CardKind,
  TextRewriteApplication,
  TextRewriteSelection,
} from "../types";
import { SaveGlobalButton } from "../assets/ProjectAssets";
import { RichTextCardEditor } from "./RichTextCardEditor";

type CanvasActions = {
  beginChange: () => void;
  selectCard: (id: string) => void;
  updateCard: (id: string, patch: Partial<CanvasCardData>) => void;
  removeCard: (id: string) => void;
  removeReference: (id: string) => void;
  duplicateCard: (id: string) => void;
  uploadMedia: (id: string, file: File) => void;
  recoverMedia: (id: string) => void;
  imageBusyNodeId: string | null;
  videoBusyNodeId: string | null;
  focusImageWriter: (id: string) => void;
  focusVideoWriter: (id: string) => void;
  adjacentCardMenuId?: string;
  openAdjacentCardMenu: (id: string, anchor: { x: number; y: number }) => void;
  rewriteApplication: TextRewriteApplication | null;
  rewriteBusy: boolean;
  requestTextRewrite: (selection: TextRewriteSelection) => void;
  completeTextRewrite: (applicationId: string, error?: string) => void;
};

export const CanvasActionsContext = createContext<CanvasActions | null>(null);

const cardMeta: Record<
  CardKind,
  {
    label: string;
    icon: typeof FileText;
    accept?: string;
    emptyTitle?: string;
    emptyHint?: string;
  }
> = {
  text: {
    label: "文字",
    icon: FileText,
  },
  image: {
    label: "图片",
    icon: ImagePlus,
    accept: "image/*",
    emptyTitle: "添加一张图片",
    emptyHint: "点击选择，或把图片拖到这里",
  },
  video: {
    label: "视频",
    icon: Clapperboard,
    accept: "video/*",
    emptyTitle: "添加一段视频",
    emptyHint: "点击选择，或把视频拖到这里",
  },
};

function useCanvasActions() {
  const actions = useContext(CanvasActionsContext);
  if (!actions) {
    throw new Error("CanvasActionsContext is missing");
  }
  return actions;
}

function VideoEmptyState({ id }: { id: string }) {
  const actions = useCanvasActions();
  const inputRef = useRef<HTMLInputElement>(null);

  const useFile = (file?: File) => {
    if (file && file.type.startsWith("video/")) {
      actions.uploadMedia(id, file);
    }
  };

  return (
    <div
      className="video-generation-empty"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        useFile(event.dataTransfer.files?.[0]);
      }}
    >
      <input
        ref={inputRef}
        className="visually-hidden"
        type="file"
        accept="video/*"
        onChange={(event) => {
          useFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      <button
        className="video-generation-primary"
        type="button"
        onClick={() => actions.focusVideoWriter(id)}
      >
        <span className="video-generation-empty-icon">
          <Clapperboard size={19} strokeWidth={1.75} />
        </span>
        <strong>生成一段视频</strong>
        <small>输入动作、场景和镜头描述</small>
      </button>
      <button
        className="video-upload-secondary nodrag"
        type="button"
        onClick={() => inputRef.current?.click()}
      >
        <Upload size={13} strokeWidth={1.8} />
        或上传本地视频
      </button>
    </div>
  );
}

function ImageEmptyState({ id }: { id: string }) {
  const actions = useCanvasActions();

  return (
    <button
      className="image-generation-empty"
      type="button"
      onClick={() => actions.focusImageWriter(id)}
    >
      <span className="image-generation-empty-icon">
        <ImagePlus size={19} strokeWidth={1.75} />
      </span>
      <strong>生成一张图片</strong>
      <small>在底部输入提示词和画面参数</small>
    </button>
  );
}

function MediaPreview({
  id,
  data,
}: {
  id: string;
  data: CanvasCardData;
}) {
  const actions = useCanvasActions();
  const inputRef = useRef<HTMLInputElement>(null);
  const kind = data.kind as "image" | "video";

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      actions.uploadMedia(id, file);
    }
    event.target.value = "";
  };

  return (
    <div className="media-preview">
      {kind === "image" ? (
        <img
          src={data.assetUrl}
          alt={data.fileName || "画布图片"}
          draggable={false}
          onError={() => actions.recoverMedia(id)}
        />
      ) : (
        <video
          src={data.assetUrl}
          controls
          preload="metadata"
          onError={() => actions.recoverMedia(id)}
        />
      )}
      {kind === "image" ? null : (
        <div className="media-preview-actions nodrag">
          {data.assetId && <SaveGlobalButton assetId={data.assetId} compact/>}
          <input
            ref={inputRef}
            className="visually-hidden"
            type="file"
            accept={cardMeta[kind].accept}
            onChange={handleChange}
          />
          <button
            type="button"
            onClick={() => actions.focusVideoWriter(id)}
            title="调整参数并重新生成"
          >
            <RotateCcw size={14} strokeWidth={1.8} />
            重新生成
          </button>
          <button
            type="button"
            onClick={() => {
              const link = document.createElement("a");
              link.href = data.assetUrl || "";
              link.download = data.fileName || "剧影海生成视频.mp4";
              link.click();
            }}
            title="下载视频"
          >
            <Download size={14} strokeWidth={1.8} />
          </button>
          <button
            className="media-replace"
            type="button"
            onClick={() => inputRef.current?.click()}
            title={`替换${cardMeta[kind].label}`}
          >
            <Replace size={15} strokeWidth={1.75} />
          </button>
        </div>
      )}
    </div>
  );
}

export function CanvasCard({
  id,
  data,
  selected,
}: NodeProps<CanvasNode>) {
  const actions = useCanvasActions();
  const [previewOpen, setPreviewOpen] = useState(false);
  const previewDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (previewOpen) previewDialog.current?.showModal(); else previewDialog.current?.close(); }, [previewOpen]);
  const imageReady = data.kind === "image" && !!data.assetUrl;
  const downloadImage = () => { const link = document.createElement("a"); link.href = data.assetUrl || ""; link.download = data.fileName || "剧影海图片.png"; link.click(); };
  const meta = cardMeta[data.kind];
  const Icon = meta.icon;
  const imageGenerating =
    data.kind === "image" && actions.imageBusyNodeId === id;
  const videoGenerating =
    data.kind === "video" && actions.videoBusyNodeId === id;

  return (
    <>
      <>
          <Handle
            className="reference-handle reference-handle-target"
            type="target"
            position={Position.Left}
            title="接收参考"
          />
          <Handle
            className="reference-handle reference-handle-source"
            type="source"
            position={Position.Right}
            title="拖出参考连线"
          />
      </>

      <NodeResizer
        isVisible={selected}
        minWidth={data.kind === "text" ? 220 : 260}
        minHeight={data.kind === "text" ? 130 : 190}
        lineClassName="node-resizer-line"
        handleClassName="node-resizer-handle"
        onResizeStart={actions.beginChange}
      />

      {imageReady && <NodeToolbar position={Position.Top} offset={30} isVisible={!!selected} className="canvas-image-toolbar nodrag nopan">
        <button type="button" title="调整参数并重新生成" onClick={() => actions.focusImageWriter(id)}><RotateCcw size={15}/>重新生成</button>
        {data.assetId && <SaveGlobalButton assetId={data.assetId} compact/>}
        <span className="image-toolbar-divider"/>
        <button type="button" title="复制卡片" aria-label="复制图片卡片" onClick={() => actions.duplicateCard(id)}><Copy size={15}/></button>
        <button type="button" title="删除卡片" aria-label="删除图片卡片" onClick={() => actions.removeCard(id)}><Trash2 size={15}/></button>
        <span className="image-toolbar-divider"/>
        <button type="button" title="下载图片" onClick={downloadImage}><Download size={16}/></button>
        <button type="button" title="放大看图" onClick={() => setPreviewOpen(true)}><Maximize2 size={16}/></button>
      </NodeToolbar>}
      {imageReady && createPortal(<dialog ref={previewDialog} className="asset-preview-dialog canvas-image-preview nodrag nopan" aria-label="图片大图预览" onCancel={() => setPreviewOpen(false)} onClose={() => setPreviewOpen(false)}>
        <header><div><h2>图片预览</h2><p>{data.fileName || "画布图片"}</p></div><button type="button" title="关闭图片预览" onClick={() => setPreviewOpen(false)}><X size={20}/></button></header>
        <div className="asset-large-media"><img src={data.assetUrl} alt={data.fileName || "画布图片"}/></div>
        <footer><span>原图预览</span><div className="global-preview-actions"><button type="button" onClick={downloadImage}><Download size={16}/>下载图片</button></div></footer>
      </dialog>, document.body)}
      <article className={`canvas-card canvas-card-${data.kind} ${imageReady ? "canvas-image-ready" : ""}`}>
      <header className="canvas-card-header">
        <span className="canvas-card-kind">
          <Icon size={15} strokeWidth={1.75} />
          {meta.label}
        </span>
        <span className="canvas-card-meta">
          {data.kind === "image" && data.imageGeneration
            ? `${data.imageGeneration.aspectRatio === "adaptive" ? "自适应" : data.imageGeneration.aspectRatio} · ${data.imageGeneration.resolution}`
            : data.kind === "video" && data.videoGeneration
              ? `${data.videoGeneration.aspectRatio === "adaptive" ? "自适应" : data.videoGeneration.aspectRatio} · ${data.videoGeneration.resolution} · ${data.videoGeneration.seconds}s`
            : data.fileName ||
              (data.kind === "text"
                ? `${data.text?.length || 0} 字`
                : data.kind === "image"
                  ? "待生成"
                  : "未添加")}
        </span>
        <span className="canvas-card-actions nodrag">
          <button
            type="button"
            onClick={() => actions.duplicateCard(id)}
            title="复制卡片"
          >
            <Copy size={14} strokeWidth={1.8} />
          </button>
          <button
            className="danger-action"
            type="button"
            onClick={() => actions.removeCard(id)}
            title="删除卡片"
          >
            <Trash2 size={14} strokeWidth={1.8} />
          </button>
        </span>
      </header>

      <div className={`canvas-card-body canvas-card-body-${data.kind}`}>
        {data.kind === "text" ? (
          <RichTextCardEditor
            id={id}
            text={data.text || ""}
            selected={selected}
            beginChange={actions.beginChange}
            selectCard={() => actions.selectCard(id)}
            updateText={(cardId, text) =>
              actions.updateCard(cardId, { text })
            }
            rewriteApplication={
              actions.rewriteApplication?.nodeId === id
                ? actions.rewriteApplication
                : undefined
            }
            rewriteBusy={actions.rewriteBusy}
            requestRewrite={actions.requestTextRewrite}
            completeRewrite={actions.completeTextRewrite}
          />
        ) : data.assetUrl ? (
          <MediaPreview id={id} data={data} />
        ) : data.kind === "image" ? (
          <ImageEmptyState id={id} />
        ) : (
          <VideoEmptyState id={id} />
        )}
        {imageGenerating ? (
          <div className="image-generation-progress" aria-live="polite">
            <span>
              <LoaderCircle className="agent-spinner" size={19} strokeWidth={1.9} />
            </span>
            <strong>正在生成图片</strong>
            <small>可以继续浏览画布，完成后会自动写入卡片</small>
          </div>
        ) : null}
        {videoGenerating ? (
          <div className="video-generation-progress" aria-live="polite">
            <span>
              <LoaderCircle className="agent-spinner" size={19} strokeWidth={1.9} />
            </span>
            <strong>正在生成视频</strong>
            <small>视频生成时间较长，完成后会自动写入当前卡片</small>
          </div>
        ) : null}
      </div>

      <button
        className="card-side-add nodrag nopan"
        type="button"
        aria-label={`从${meta.label}卡片添加节点`}
        aria-haspopup="menu"
        aria-expanded={actions.adjacentCardMenuId === id}
        title="添加节点"
        onClick={(event) => {
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          actions.openAdjacentCardMenu(id, { x: rect.right + 8, y: rect.top });
        }}
      >
        <Plus size={17} strokeWidth={1.9} />
      </button>
      </article>
    </>
  );
}
