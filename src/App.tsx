import { accountStorage } from "./auth/accountStorage";
import { AccountButton } from "./auth/AuthProvider";
import { SourceFooter } from "./components/SourceFooter";
import { resolveApiUrl } from "./lib/apiClient";
import { cloudActive } from "./lib/hosted";
import { loadModelCatalog, configValue, saveModelSelection, selectedConfig, modelLabel, type ModelCatalog } from "./lib/modelConfigs";
import {
  Background,
  BackgroundVariant,
  MarkerType,
  MiniMap,
  ReactFlow,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type Viewport,
} from "@xyflow/react";
import {
  Check,
  ChevronDown,
  Clapperboard,
  Cpu,
  FileText,
  ImagePlus,
  LoaderCircle,
  Maximize2,
  MessageCircle,
  LayoutGrid,
  Map as MapIcon,
  Magnet,
  Keyboard,
  ArrowUp,
  Square,
  Minus,
  PanelLeftOpen,
  Plus,
  Redo2,
  RotateCcw,
  Send,
  Bot,
  Undo2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CanvasActionsContext,
  CanvasCard,
} from "./components/CanvasCard";
import { CanvasSidebar } from "./components/CanvasSidebar";
import { ImageWriterDock } from "./components/ImageWriterDock";
import {
  ModelManager,
  type ModelServiceStatus,
} from "./components/ModelManager";
import { ReferenceEdge } from "./components/ReferenceEdge";
import { TextWriterDock } from "./components/TextWriterDock";
import { VideoWriterDock } from "./components/VideoWriterDock";
import {
  planCanvasInstruction,
  describeAction,
  localPlan,
  type CanvasAgentMode,
  type CanvasAgentPlan,
} from "./agent/canvasAgent";
import {
  blobToDataUrl,
  dataUrlToFile,
  DEFAULT_IMAGE_SETTINGS,
  generateImages,
  mediaUrlToDataUrl,
  optimizeImagePrompt,
  type ImageReference,
  type ImageReferenceOption,
} from "./lib/imageWriter";
import { tidyCanvas, CANVAS_GRID_SIZE } from "./lib/tidyCanvas";
import { ProjectAssetsButton } from "./assets/ProjectAssets";
import { deleteMedia, readMedia, registerProjectAsset, saveMedia, type ProjectAsset } from "./lib/mediaStore";
import {
  generateTextForCard,
  rewriteTextSelection,
  type TextReference,
} from "./lib/textWriter";
import {
  DEFAULT_VIDEO_SETTINGS,
  VideoCancelled,
  cancelActiveVideo,
  generateVideo,
  optimizeVideoPrompt,
} from "./lib/videoWriter";
import type {
  CanvasCardData,
  CanvasEdge,
  CanvasNode,
  CardKind,
  ImageGenerationSettings,
  ProjectCanvas,
  SavedCanvas,
  SavedProject,
  TextRewriteApplication,
  TextRewriteSelection,
  VideoGenerationSettings,
} from "./types";

import { ProjectManager, type WorkspaceProps } from "./projects/ProjectManager";

import { applyCanvasPlan, canvasFingerprint } from "./agent/applyCanvasPlan";

const PROJECT_STORAGE_KEY = "mjh.project.v2";
const STORAGE_KEY = "mjh.canvas.mvp.v1";
const LEGACY_STORAGE_KEY = "mlh.canvas.mvp.v1";
const TEXT_MODEL_STORAGE_KEY = "mjh.text-model.v1";
const IMAGE_SETTINGS_STORAGE_KEY = "mjh.image-settings.v1";
const VIDEO_SETTINGS_STORAGE_KEY = "mjh.video-settings.v1";
const DEFAULT_VIEWPORT = { x: 0, y: 0, zoom: 1 };
const MAX_REFERENCES = 5;

const starterNodes: CanvasNode[] = [
  {
    id: "starter-text",
    type: "canvas-card",
    position: { x: 160, y: 142 },
    style: { width: 290, height: 190 },
    data: {
      kind: "text",
      text: "雨夜，城市最后一家便利店。\n\n林默推门进来，发现收银台后站着十年后的自己。",
    },
  },
  {
    id: "starter-image",
    type: "canvas-card",
    position: { x: 515, y: 100 },
    style: { width: 310, height: 250 },
    data: {
      kind: "image",
    },
  },
  {
    id: "starter-video",
    type: "canvas-card",
    position: { x: 515, y: 410 },
    style: { width: 350, height: 250 },
    data: {
      kind: "video",
    },
  },
];

const cardSizes: Record<CardKind, { width: number; height: number }> = {
  text: { width: 290, height: 190 },
  image: { width: 310, height: 250 },
  video: { width: 350, height: 250 },
};

type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
  steps?: string[];
  mode?: CanvasAgentMode;
  notice?: string;
  confirmation?: boolean;
  plan?: CanvasAgentPlan;
  undoable?: boolean;
};

type CanvasContextMenu = {
  sourceId?: string;
  screenX: number;
  screenY: number;
  flowPosition: {
    x: number;
    y: number;
  };
};

function createId() {
  return crypto.randomUUID();
}

function cloneNodes(nodes: CanvasNode[]) {
  return nodes.map((node) => ({
    ...node,
    position: { ...node.position },
    style: node.style ? { ...node.style } : undefined,
    data: { ...node.data },
    selected: false,
  }));
}

function cloneEdges(edges: CanvasEdge[]) {
  return edges.map((edge) => ({
    ...edge,
    data: edge.data ? { ...edge.data } : undefined,
    markerEnd:
      edge.markerEnd && typeof edge.markerEnd === "object"
        ? { ...edge.markerEnd }
        : edge.markerEnd,
    selected: false,
  }));
}

function referenceEdgeId(source: string, target: string) {
  return `reference:${source}->${target}`;
}

function createReferenceEdge(source: string, target: string): CanvasEdge {
  return {
    id: referenceEdgeId(source, target),
    source,
    target,
    type: "reference",
    data: { relation: "reference" },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: "#999999",
      width: 16,
      height: 16,
    },
  };
}

type CanvasHistorySnapshot = {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
};

function cloneCanvasSnapshot(snapshot: CanvasHistorySnapshot): CanvasHistorySnapshot {
  return {
    nodes: cloneNodes(snapshot.nodes),
    edges: cloneEdges(snapshot.edges),
  };
}

function snapshotNodes(nodes: CanvasNode[]) {
  return nodes.map((node) => ({
    ...node,
    position: { ...node.position },
    style: node.style ? { ...node.style } : undefined,
    data: { ...node.data },
    selected: Boolean(node.selected),
  }));
}

function initialEdgesForCanvas(savedCanvas: SavedCanvas | null): CanvasEdge[] {
  if (!savedCanvas) {
    return [];
  }
  if (savedCanvas.edges) {
    const nodeIds = new Set(savedCanvas.nodes.map((node) => node.id));
    return savedCanvas.edges
      .filter(
        (edge) =>
          edge.source !== edge.target &&
          nodeIds.has(edge.source) &&
          nodeIds.has(edge.target),
      )
      .map((edge) => ({
        ...createReferenceEdge(edge.source, edge.target),
        data: edge.data || { relation: "reference" },
        selected: false,
      }));
  }

  const nodeIds = new Set(savedCanvas.nodes.map((node) => node.id));
  return savedCanvas.nodes.flatMap((node) =>
    (node.data.imageGeneration?.referenceIds || [])
      .filter((sourceId) => sourceId !== node.id && nodeIds.has(sourceId))
      .slice(0, MAX_REFERENCES)
      .map((sourceId) => createReferenceEdge(sourceId, node.id)),
  );
}

function readSavedCanvas(): SavedCanvas | null {
  try {
    const currentValue = accountStorage.getItem(STORAGE_KEY);
    if (currentValue) {
      return JSON.parse(currentValue) as SavedCanvas;
    }

    const legacyValue = accountStorage.getItem(LEGACY_STORAGE_KEY);
    if (!legacyValue) {
      return null;
    }

    const migratedCanvas = JSON.parse(legacyValue) as SavedCanvas;
    accountStorage.setItem(STORAGE_KEY, legacyValue);
    return migratedCanvas;
  } catch {
    return null;
  }
}

function createProjectCanvas(
  title: string,
  nodes: CanvasNode[] = [],
  edges: CanvasEdge[] = [],
  viewport: Viewport = DEFAULT_VIEWPORT,
): ProjectCanvas {
  const timestamp = new Date().toISOString();
  return {
    id: createId(),
    title,
    nodes: cloneNodes(nodes),
    edges: cloneEdges(edges),
    viewport: { ...viewport },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function readSavedProject(): SavedProject {
  try {
    const storedProject = accountStorage.getItem(PROJECT_STORAGE_KEY);
    if (storedProject) {
      const parsed = JSON.parse(storedProject) as Partial<SavedProject>;
      if (
        parsed.version === 2 &&
        typeof parsed.projectTitle === "string" &&
        typeof parsed.activeCanvasId === "string" &&
        Array.isArray(parsed.canvases) &&
        parsed.canvases.length > 0
      ) {
        const canvases = parsed.canvases.map((canvas) => ({
          ...canvas,
          nodes: Array.isArray(canvas.nodes) ? cloneNodes(canvas.nodes) : [],
          edges: Array.isArray(canvas.edges) ? cloneEdges(canvas.edges) : [],
          viewport: canvas.viewport
            ? { ...canvas.viewport }
            : { ...DEFAULT_VIEWPORT },
        }));
        const activeCanvasId = canvases.some(
          (canvas) => canvas.id === parsed.activeCanvasId,
        )
          ? parsed.activeCanvasId
          : canvases[0].id;
        return {
          version: 2,
          projectTitle: parsed.projectTitle,
          activeCanvasId,
          canvases,
        };
      }
    }
  } catch {
    // Fall through to the legacy migration or a fresh project.
  }

  const legacyCanvas = readSavedCanvas();
  const firstCanvas = createProjectCanvas(
    "第 1 集",
    legacyCanvas?.nodes?.length ? legacyCanvas.nodes : starterNodes,
    initialEdgesForCanvas(legacyCanvas),
    legacyCanvas?.viewport || DEFAULT_VIEWPORT,
  );
  return {
    version: 2,
    projectTitle: legacyCanvas?.projectTitle || "未命名漫剧",
    activeCanvasId: firstCanvas.id,
    canvases: [firstCanvas],
  };
}

function snapshotProjectCanvas(
  canvas: ProjectCanvas,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  viewport: Viewport,
): ProjectCanvas {
  return {
    ...canvas,
    nodes: cloneNodes(nodes),
    edges: cloneEdges(edges),
    viewport: { ...viewport },
    updatedAt: new Date().toISOString(),
  };
}

function stripRuntimeMedia(nodes: CanvasNode[]) {
  return nodes.map((node) => ({
    ...node,
    selected: false,
    data: {
      ...node.data,
      assetUrl: undefined,
    },
  }));
}

function duplicateProjectCanvas(source: ProjectCanvas, title: string) {
  const nodeIds = new Map<string, string>();
  const nodes = source.nodes.map((node) => {
    const id = createId();
    nodeIds.set(node.id, id);
    return {
      ...node,
      id,
      position: { ...node.position },
      style: node.style ? { ...node.style } : undefined,
      data: { ...node.data },
      selected: false,
    };
  });
  const edges = (source.edges || []).flatMap<CanvasEdge>((edge) => {
    const sourceId = nodeIds.get(edge.source);
    const targetId = nodeIds.get(edge.target);
    if (!sourceId || !targetId) {
      return [];
    }
    return [
      {
        ...createReferenceEdge(sourceId, targetId),
        id: createId(),
      },
    ];
  });
  return createProjectCanvas(title, nodes, edges, source.viewport);
}

function uniqueCanvasTitle(canvases: ProjectCanvas[], requestedTitle: string) {
  const existing = new Set(canvases.map((canvas) => canvas.title));
  if (!existing.has(requestedTitle)) {
    return requestedTitle;
  }

  let suffix = 2;
  while (existing.has(`${requestedTitle} ${suffix}`)) {
    suffix += 1;
  }
  return `${requestedTitle} ${suffix}`;
}

function nextCanvasTitle(canvases: ProjectCanvas[]) {
  const episodeNumbers = canvases.flatMap((canvas) => {
    const match = /^第\s*(\d+)\s*集$/.exec(canvas.title.trim());
    return match ? [Number(match[1])] : [];
  });
  if (episodeNumbers.length > 0) {
    return `第 ${Math.max(...episodeNumbers) + 1} 集`;
  }
  return uniqueCanvasTitle(canvases, "新画布");
}

function readSavedImageSettings(): ImageGenerationSettings {
  try {
    const saved = accountStorage.getItem(IMAGE_SETTINGS_STORAGE_KEY);
    if (!saved) {
      return DEFAULT_IMAGE_SETTINGS;
    }
    const parsed = JSON.parse(saved) as Partial<ImageGenerationSettings>;
    return {
      ...DEFAULT_IMAGE_SETTINGS,
      ...parsed,
      count: [1, 2, 4].includes(Number(parsed.count))
        ? Number(parsed.count)
        : DEFAULT_IMAGE_SETTINGS.count,
    };
  } catch {
    return DEFAULT_IMAGE_SETTINGS;
  }
}

function readSavedVideoSettings(): VideoGenerationSettings {
  try {
    const saved = accountStorage.getItem(VIDEO_SETTINGS_STORAGE_KEY);
    if (!saved) {
      return DEFAULT_VIDEO_SETTINGS;
    }
    const parsed = JSON.parse(saved) as Partial<VideoGenerationSettings>;
    return {
      ...DEFAULT_VIDEO_SETTINGS,
      ...parsed,
      duration: parsed.duration === 10 ? 10 : 5,
      resolution: "720p",
    };
  } catch {
    return DEFAULT_VIDEO_SETTINGS;
  }
}

function CanvasWorkspace({ projectId, initialProject, onSave, onHome, registerExit }: WorkspaceProps) {
  const [savedProject] = useState(initialProject);
  const initialCanvas =
    savedProject.canvases.find(
      (canvas) => canvas.id === savedProject.activeCanvasId,
    ) || savedProject.canvases[0];
  const [canvases, setCanvases] = useState<ProjectCanvas[]>(
    savedProject.canvases,
  );
  const [activeCanvasId, setActiveCanvasId] = useState(
    savedProject.activeCanvasId,
  );
  const [canvasListOpen, setCanvasListOpen] = useState(() => window.innerWidth > 760);
  const [miniMapOpen, setMiniMapOpen] = useState(true);
  const [snapToGrid, setSnapToGrid] = useState(false);
  const [tidyPreview, setTidyPreview] = useState<{ nodes: CanvasNode[]; originalViewport: Viewport } | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [agentSource, setAgentSource] = useState<CanvasAgentMode>("ai");
  const agentController = useRef<AbortController | null>(null);
  const pendingFingerprint = useRef("");
  const agentAfterFingerprint = useRef("");
  const messagesEnd = useRef<HTMLDivElement>(null);
  const [nodes, setNodes] = useState<CanvasNode[]>(
    initialCanvas.nodes,
  );
  const [edges, setEdges] = useState<CanvasEdge[]>(
    initialCanvas.edges || [],
  );
  const [projectTitle, setProjectTitle] = useState(
    savedProject.projectTitle,
  );
  const [viewport, setViewportState] = useState<Viewport>(
    initialCanvas.viewport,
  );
  const [saveState, setSaveState] = useState<"saving" | "saved" | "error">(
    "saved",
  );
  const [assistantOpen, setAssistantOpen] = useState(() => window.innerWidth > 1100);
  const [modelManagerOpen, setModelManagerOpen] = useState(false);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog | null>(null);
  const [modelConnectionError, setModelConnectionError] = useState("");
  const [modelsReload, setModelsReload] = useState(0);
  const refreshModels = useCallback(() => setModelsReload(v => v + 1), []);
  const [contextMenu, setContextMenu] = useState<CanvasContextMenu | null>(null);
  const [composer, setComposer] = useState("");
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentMode, setAgentMode] = useState<CanvasAgentMode | "idle">("idle");
  const [textWriterPrompt, setTextWriterPrompt] = useState("");
  const [textWriterBusy, setTextWriterBusy] = useState(false);
  const [textWriterModel, setTextWriterModel] = useState("文本模型");
  const [textWriterModels, setTextWriterModels] = useState<string[]>([]);
  const [textWriterProvider, setTextWriterProvider] = useState("Agnes AI");
  const [textWriterStatus, setTextWriterStatus] =
    useState<ModelServiceStatus>("loading");
  const [imageWriterPrompt, setImageWriterPrompt] = useState("");
  const [imageWriterSettings, setImageWriterSettings] =
    useState<ImageGenerationSettings>(readSavedImageSettings);
  const [imageWriterModels, setImageWriterModels] = useState<string[]>([]);
  const [imageWriterConfigured, setImageWriterConfigured] = useState(false);
  const [imageWriterProvider, setImageWriterProvider] = useState("Agnes AI");
  const [imageWriterStatus, setImageWriterStatus] =
    useState<ModelServiceStatus>("loading");
  const [imageWriterBusy, setImageWriterBusy] = useState(false);
  const [imageWriterBusyNodeId, setImageWriterBusyNodeId] = useState<
    string | null
  >(null);
  const [imageWriterOptimizing, setImageWriterOptimizing] = useState(false);
  const [imageWriterFocusVersion, setImageWriterFocusVersion] = useState(0);
  const [imageWriterFeedback, setImageWriterFeedback] = useState<{
    type: "success" | "error";
    text: string;
    nodeId: string;
  } | null>(null);
  const [imageWriterUndo, setImageWriterUndo] = useState<{
    nodeId: string;
    previousData: CanvasCardData;
    createdNodeIds: string[];
    generatedAssetIds: string[];
    generatedAssetUrls: string[];
  } | null>(null);
  const [videoWriterPrompt, setVideoWriterPrompt] = useState("");
  const [videoWriterSettings, setVideoWriterSettings] =
    useState<VideoGenerationSettings>(readSavedVideoSettings);
  const [videoWriterModels, setVideoWriterModels] = useState<string[]>([]);
  const [videoWriterConfigured, setVideoWriterConfigured] = useState(false);
  const [videoWriterProvider, setVideoWriterProvider] = useState("Agnes AI");
  const [videoWriterStatus, setVideoWriterStatus] =
    useState<ModelServiceStatus>("loading");
  const [videoWriterBusy, setVideoWriterBusy] = useState(false);
  const [videoWriterBusyNodeId, setVideoWriterBusyNodeId] = useState<
    string | null
  >(null);
  const [videoWriterOptimizing, setVideoWriterOptimizing] = useState(false);
  const [videoWriterFocusVersion, setVideoWriterFocusVersion] = useState(0);
  const [videoWriterFeedback, setVideoWriterFeedback] = useState<{
    type: "success" | "error";
    text: string;
    nodeId: string;
  } | null>(null);
  const [videoWriterUndo, setVideoWriterUndo] = useState<{
    nodeId: string;
    previousData: CanvasCardData;
    generatedAssetId: string;
    generatedAssetUrl: string;
  } | null>(null);
  const [textRewriteSelection, setTextRewriteSelection] =
    useState<TextRewriteSelection | null>(null);
  const [textRewriteApplication, setTextRewriteApplication] =
    useState<TextRewriteApplication | null>(null);
  const [textWriterFocusVersion, setTextWriterFocusVersion] = useState(0);
  const [textWriterFeedback, setTextWriterFeedback] = useState<{
    type: "success" | "error";
    text: string;
    nodeId: string;
  } | null>(null);
  const [textWriterUndo, setTextWriterUndo] = useState<{
    nodeId: string;
    previousText: string;
    action: "生成" | "改写";
  } | null>(null);
  const [pendingAgentPlan, setPendingAgentPlan] =
    useState<CanvasAgentPlan | null>(null);
  const [agentUndo, setAgentUndo] = useState<{
    messageId: string;
    snapshot: CanvasHistorySnapshot;
  } | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "hello",
      role: "assistant",
      text: "从一个想法，到完整分镜。\n选中剧本，告诉我接下来想做什么。",
    },
  ]);
  const [historyVersion, setHistoryVersion] = useState(0);
  const canvasesRef = useRef(canvases);
  const activeCanvasIdRef = useRef(activeCanvasId);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const viewportRef = useRef(viewport);
  const pastRef = useRef<CanvasHistorySnapshot[]>([]);
  const futureRef = useRef<CanvasHistorySnapshot[]>([]);
  const workspaceMountedRef = useRef(true);
  const objectUrlsRef = useRef(new Set<string>());
  const canvasLoadRequestRef = useRef(0);
  const textWriterRequestRef = useRef(0);
  const imageWriterRequestRef = useRef(0);
  const videoWriterRequestRef = useRef(0);
  const reactFlow = useReactFlow<CanvasNode>();
  const closeModelManager = useCallback(() => {
    setModelManagerOpen(false);
  }, []);

  useEffect(() => {
    canvasesRef.current = canvases;
  }, [canvases]);

  useEffect(() => {
    activeCanvasIdRef.current = activeCanvasId;
  }, [activeCanvasId]);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);

  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);

  useEffect(() => {
    const nodeIds = new Set(nodes.map((node) => node.id));
    setEdges((current) => {
      const next = current.filter(
        (edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target),
      );
      return next.length === current.length ? current : next;
    });
  }, [nodes]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (attempt = 0) => {
      try {
        const { catalog, selections } = await loadModelCatalog({
          text: accountStorage.getItem(TEXT_MODEL_STORAGE_KEY),
          image: readSavedImageSettings().model,
          video: readSavedVideoSettings().model,
        });
        if (cancelled) return;
        setModelCatalog(catalog);
        setModelConnectionError("");
        const configs = (kind: "text" | "image" | "video") => catalog.configs.filter(c => c.kind === kind).map(configValue);
        setTextWriterModels(configs("text"));
        setImageWriterModels(configs("image"));
        setVideoWriterModels(configs("video"));
        setTextWriterModel(selections.text);
        setImageWriterSettings(current => ({ ...current, model: selections.image }));
        setVideoWriterSettings(current => ({ ...current, model: selections.video }));
        const text = selectedConfig("text");
        const image = selectedConfig("image");
        const video = selectedConfig("video");
        setTextWriterProvider(text?.name || "请选择模型");
        setImageWriterProvider(image?.name || "请选择模型");
        setVideoWriterProvider(video?.name || "请选择模型");
        setTextWriterStatus(text?.configured ? "configured" : "unconfigured");
        setImageWriterStatus(image?.configured ? "configured" : "unconfigured");
        setVideoWriterStatus(video?.configured ? "configured" : "unconfigured");
        setImageWriterConfigured(Boolean(image?.configured));
        setVideoWriterConfigured(Boolean(video?.configured));
      } catch (error) {
        if (cancelled) return;
        setModelConnectionError(error instanceof Error ? error.message : "本机后端未连接");
        setTextWriterStatus("unavailable");
        setImageWriterStatus("unavailable");
        setVideoWriterStatus("unavailable");
        setImageWriterConfigured(false);
        setVideoWriterConfigured(false);
        if (attempt < 2) timer = setTimeout(() => void load(attempt + 1), 2000 * (attempt + 1));
      }
    };
    void load();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [modelsReload, modelManagerOpen]);

  useEffect(() => {
    const closeContextMenu = (event: PointerEvent) => {
      if (!(event.target as HTMLElement).closest(".canvas-context-menu")) {
        setContextMenu(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAddMenuOpen(false);
        setShortcutsOpen(false);
        setContextMenu(null);
      }
    };

    document.addEventListener("pointerdown", closeContextMenu);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeContextMenu);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  const hydrateNodesWithMedia = useCallback(async (sourceNodes: CanvasNode[]) => {
    return Promise.all(
      sourceNodes.map(async (node) => {
        if (!node.data.assetId || node.data.assetUrl) {
          return node;
        }

        const media = await readMedia(node.data.assetId).catch(() => undefined);
        if (!media) {
          return node;
        }

        const assetUrl = URL.createObjectURL(media.blob);
        objectUrlsRef.current.add(assetUrl);
        return {
          ...node,
          data: {
            ...node.data,
            assetUrl,
            fileName: node.data.fileName || media.fileName,
          },
        };
      }),
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    const requestId = ++canvasLoadRequestRef.current;

    void hydrateNodesWithMedia(nodesRef.current).then((hydratedNodes) => {
      if (!cancelled && requestId === canvasLoadRequestRef.current) {
        nodesRef.current = hydratedNodes;
        setNodes(hydratedNodes);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [hydrateNodesWithMedia]);

  useEffect(() => {
    workspaceMountedRef.current = true;
    return () => {
      workspaceMountedRef.current = false;
      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      objectUrlsRef.current.clear();
    };
  }, []);

  const persistProject = useCallback(() => {
    const timestamp = new Date().toISOString();
    const serializableCanvases = canvases.map((canvas) => canvas.id === activeCanvasId ? {
      ...canvas, nodes: stripRuntimeMedia(nodes), edges: cloneEdges(edges),
      viewport: { ...(tidyPreview?.originalViewport || viewport) }, updatedAt: timestamp,
    } : { ...canvas, nodes: stripRuntimeMedia(canvas.nodes), edges: cloneEdges(canvas.edges || []) });
    try {
      onSave({ version: 2, projectTitle, activeCanvasId, canvases: serializableCanvases });
      setSaveState("saved");
      return true;
    } catch {
      setSaveState("error");
      return false;
    }
  }, [activeCanvasId, canvases, edges, nodes, projectTitle, viewport, onSave, tidyPreview]);

  useEffect(() => {
    setSaveState("saving");
    const timeout = window.setTimeout(persistProject, 240);
    return () => window.clearTimeout(timeout);
  }, [persistProject]);

  useEffect(() => {
    // Flush the latest committed layout if the page closes during the save debounce.
    window.addEventListener("pagehide", persistProject);
    window.addEventListener("beforeunload", persistProject);
    return () => {
      window.removeEventListener("pagehide", persistProject);
      window.removeEventListener("beforeunload", persistProject);
    };
  }, [persistProject]);

  const beginChange = useCallback(() => {
    pastRef.current = [
      ...pastRef.current.slice(-29),
      {
        nodes: cloneNodes(nodesRef.current),
        edges: cloneEdges(edgesRef.current),
      },
    ];
    futureRef.current = [];
    setHistoryVersion((version) => version + 1);
  }, []);

  const undo = useCallback(() => {
    const previous = pastRef.current.at(-1);
    if (!previous) {
      return;
    }
    pastRef.current = pastRef.current.slice(0, -1);
    futureRef.current = [{
      nodes: cloneNodes(nodesRef.current),
      edges: cloneEdges(edgesRef.current),
    }, ...futureRef.current.slice(0, 29)];
    const restored = cloneCanvasSnapshot(previous);
    setNodes(restored.nodes);
    setEdges(restored.edges);
    setHistoryVersion((version) => version + 1);
  }, []);

  const redo = useCallback(() => {
    const next = futureRef.current[0];
    if (!next) {
      return;
    }
    futureRef.current = futureRef.current.slice(1);
    pastRef.current = [
      ...pastRef.current.slice(-29),
      {
        nodes: cloneNodes(nodesRef.current),
        edges: cloneEdges(edgesRef.current),
      },
    ];
    const restored = cloneCanvasSnapshot(next);
    setNodes(restored.nodes);
    setEdges(restored.edges);
    setHistoryVersion((version) => version + 1);
  }, []);

  const canvasInteractionBusy =
    !!tidyPreview ||
    agentBusy ||
    textWriterBusy ||
    imageWriterBusy ||
    videoWriterBusy ||
    imageWriterOptimizing ||
    videoWriterOptimizing;

  const guardCanvasInteraction = useCallback(() => {
    if (!canvasInteractionBusy) {
      return true;
    }
    window.alert("当前画布正在生成内容，请等待完成后再切换或管理画布。");
    return false;
  }, [canvasInteractionBusy]);

  useEffect(() => {
    registerExit(() => {
      if (!guardCanvasInteraction()) return false;
      if (persistProject()) return true;
      window.alert("项目尚未保存成功，请检查浏览器存储空间后重试。");
      return false;
    });
    const saveBeforeUnload = (event: BeforeUnloadEvent) => {
      const saved = persistProject();
      if (!saved || canvasInteractionBusy) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", saveBeforeUnload);
    return () => { registerExit(null); window.removeEventListener("beforeunload", saveBeforeUnload); };
  }, [registerExit, guardCanvasInteraction, persistProject, canvasInteractionBusy]);

  const captureActiveCanvas = useCallback((sourceCanvases: ProjectCanvas[]) => {
    return sourceCanvases.map((canvas) =>
      canvas.id === activeCanvasIdRef.current
        ? snapshotProjectCanvas(
            canvas,
            nodesRef.current,
            edgesRef.current,
            viewportRef.current,
          )
        : canvas,
    );
  }, []);

  const applyProjectCanvas = useCallback(
    (canvas: ProjectCanvas) => {
      const requestId = ++canvasLoadRequestRef.current;
      const nextNodes = cloneNodes(canvas.nodes);
      const nextEdges = cloneEdges(canvas.edges || []);
      const nextViewport = { ...canvas.viewport };

      activeCanvasIdRef.current = canvas.id;
      nodesRef.current = nextNodes;
      edgesRef.current = nextEdges;
      viewportRef.current = nextViewport;
      setActiveCanvasId(canvas.id);
      setNodes(nextNodes);
      setEdges(nextEdges);
      setViewportState(nextViewport);
      void reactFlow.setViewport(nextViewport, { duration: 160 });

      pastRef.current = [];
      futureRef.current = [];
      setHistoryVersion((version) => version + 1);
      setContextMenu(null);
      setPendingAgentPlan(null);
      setAgentUndo(null);
      setMessages([{id:createId(),role:"assistant",text:"已切换画布。选中内容或描述你的创作想法。"}]);
      setComposer("");
      setTextRewriteSelection(null);
      setTextRewriteApplication(null);
      setTextWriterUndo(null);
      setImageWriterUndo(null);
      setVideoWriterUndo(null);
      setTextWriterFeedback(null);
      setImageWriterFeedback(null);
      setVideoWriterFeedback(null);

      void hydrateNodesWithMedia(nextNodes).then((hydratedNodes) => {
        if (
          requestId === canvasLoadRequestRef.current &&
          activeCanvasIdRef.current === canvas.id
        ) {
          nodesRef.current = hydratedNodes;
          setNodes(hydratedNodes);
        }
      });
    },
    [hydrateNodesWithMedia, reactFlow],
  );

  const switchCanvas = useCallback(
    (canvasId: string) => {
      if (
        canvasId === activeCanvasIdRef.current ||
        !guardCanvasInteraction()
      ) {
        return;
      }
      const captured = captureActiveCanvas(canvasesRef.current);
      const target = captured.find((canvas) => canvas.id === canvasId);
      if (!target) {
        return;
      }
      canvasesRef.current = captured;
      setCanvases(captured);
      applyProjectCanvas(target);
    },
    [applyProjectCanvas, captureActiveCanvas, guardCanvasInteraction],
  );

  const createCanvas = useCallback(() => {
    if (!guardCanvasInteraction()) {
      return;
    }
    const captured = captureActiveCanvas(canvasesRef.current);
    const created = createProjectCanvas(nextCanvasTitle(captured));
    const nextCanvases = [...captured, created];
    canvasesRef.current = nextCanvases;
    setCanvases(nextCanvases);
    applyProjectCanvas(created);
  }, [applyProjectCanvas, captureActiveCanvas, guardCanvasInteraction]);

  const renameCanvas = useCallback((canvasId: string, nextTitle: string) => {
    const normalizedTitle = nextTitle.trim() || "未命名画布";
    const nextCanvases = canvasesRef.current.map((canvas) =>
      canvas.id === canvasId
        ? {
            ...canvas,
            title: normalizedTitle,
            updatedAt: new Date().toISOString(),
          }
        : canvas,
    );
    canvasesRef.current = nextCanvases;
    setCanvases(nextCanvases);
  }, []);

  const duplicateCanvas = useCallback(
    (canvasId: string) => {
      if (!guardCanvasInteraction()) {
        return;
      }
      const captured = captureActiveCanvas(canvasesRef.current);
      const sourceIndex = captured.findIndex((canvas) => canvas.id === canvasId);
      if (sourceIndex < 0) {
        return;
      }
      const source = captured[sourceIndex];
      const duplicate = duplicateProjectCanvas(
        source,
        uniqueCanvasTitle(captured, `${source.title} 副本`),
      );
      const nextCanvases = [...captured];
      nextCanvases.splice(sourceIndex + 1, 0, duplicate);
      canvasesRef.current = nextCanvases;
      setCanvases(nextCanvases);
      applyProjectCanvas(duplicate);
    },
    [applyProjectCanvas, captureActiveCanvas, guardCanvasInteraction],
  );

  const deleteCanvas = useCallback(
    (canvasId: string) => {
      if (!guardCanvasInteraction()) {
        return;
      }
      const captured = captureActiveCanvas(canvasesRef.current);
      if (captured.length === 1) {
        return;
      }
      const targetIndex = captured.findIndex(
        (canvas) => canvas.id === canvasId,
      );
      if (targetIndex < 0) {
        return;
      }

      const nextCanvases = captured.filter(
        (canvas) => canvas.id !== canvasId,
      );
      canvasesRef.current = nextCanvases;
      setCanvases(nextCanvases);

      if (canvasId === activeCanvasIdRef.current) {
        const nextActive =
          nextCanvases[Math.min(targetIndex, nextCanvases.length - 1)];
        applyProjectCanvas(nextActive);
      }
    },
    [applyProjectCanvas, captureActiveCanvas, guardCanvasInteraction],
  );

  const reorderCanvases = useCallback(
    (sourceId: string, targetId: string) => {
      const captured = captureActiveCanvas(canvasesRef.current);
      const sourceIndex = captured.findIndex(
        (canvas) => canvas.id === sourceId,
      );
      const targetIndex = captured.findIndex(
        (canvas) => canvas.id === targetId,
      );
      if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
        return;
      }
      const nextCanvases = [...captured];
      const [moved] = nextCanvases.splice(sourceIndex, 1);
      nextCanvases.splice(targetIndex, 0, moved);
      canvasesRef.current = nextCanvases;
      setCanvases(nextCanvases);
    },
    [captureActiveCanvas],
  );

  const addCard = useCallback(
    (
      kind: CardKind,
      text = "",
      requestedPosition?: { x: number; y: number },
      media?: Pick<CanvasCardData, "assetId" | "assetUrl" | "fileName">,
    ) => {
      beginChange();
      const center =
        requestedPosition ||
        reactFlow.screenToFlowPosition({
          x:
            ((canvasListOpen ? 236 : 0) +
              window.innerWidth -
              (assistantOpen ? 344 : 0)) /
            2,
          y: window.innerHeight * 0.48,
        });
      const offset = nodesRef.current.length % 6;
      const size = cardSizes[kind];
      const node: CanvasNode = {
        id: createId(),
        type: "canvas-card",
        position: {
          x: center.x - size.width / 2 + (requestedPosition ? 0 : offset * 18),
          y: center.y - size.height / 2 + (requestedPosition ? 0 : offset * 18),
        },
        style: size,
        data: {
          kind,
          text: kind === "text" ? text : undefined,
          ...media,
        },
        selected: true,
      };

      setNodes((current) => [
        ...current.map((item) => ({ ...item, selected: false })),
        node,
      ]);
      return node.id;
    },
    [assistantOpen, beginChange, canvasListOpen, reactFlow],
  );



  const useProjectAsset = async (asset: ProjectAsset) => {
    const canvasId = activeCanvasIdRef.current;
    const media = await readMedia(asset.assetId);
    if (!workspaceMountedRef.current || canvasId !== activeCanvasIdRef.current) {
      throw new Error("画布已切换，请在当前画布重新点击使用。");
    }
    if (!media) throw new Error("素材文件不可用，请重新上传。");
    const assetUrl = URL.createObjectURL(media.blob);
    objectUrlsRef.current.add(assetUrl);
    addCard(asset.kind, "", undefined, { assetId: asset.assetId, assetUrl, fileName: asset.fileName });
  };

  const openMobileAddMenu = () => {
    const screenX = Math.min(window.innerWidth - 180, 18);
    const screenY = Math.max(76, window.innerHeight - 238);
    setContextMenu({
      screenX,
      screenY,
      flowPosition: reactFlow.screenToFlowPosition({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      }),
    });
  };

  const updateCard = useCallback(
    (id: string, patch: Partial<CanvasCardData>) => {
      setNodes((current) =>
        current.map((node) =>
          node.id === id
            ? { ...node, data: { ...node.data, ...patch } }
            : node,
        ),
      );
    },
    [],
  );

  const recoverMedia = useCallback(async (id: string) => {
    const target = nodesRef.current.find((node) => node.id === id);
    if (!target?.data.assetId) {
      return;
    }

    const media = await readMedia(target.data.assetId).catch(() => undefined);
    if (!media) {
      return;
    }

    const previousUrl = target.data.assetUrl;
    const assetUrl = URL.createObjectURL(media.blob);
    objectUrlsRef.current.add(assetUrl);
    setNodes((current) =>
      current.map((node) =>
        node.id === id
          ? {
              ...node,
              data: {
                ...node.data,
                assetUrl,
                fileName: node.data.fileName || media.fileName,
              },
            }
          : node,
      ),
    );

    if (previousUrl?.startsWith("blob:")) {
      window.setTimeout(() => {
        URL.revokeObjectURL(previousUrl);
        objectUrlsRef.current.delete(previousUrl);
      }, 0);
    }
  }, []);

  const selectCard = useCallback((id: string) => {
    setNodes((current) => {
      const selectionIsCurrent = current.every(
        (node) => Boolean(node.selected) === (node.id === id),
      );
      if (selectionIsCurrent) {
        return current;
      }

      return current.map((node) => ({
        ...node,
        selected: node.id === id,
      }));
    });
  }, []);

  const focusImageWriter = useCallback(
    (id: string) => {
      const target = nodesRef.current.find(
        (node) => node.id === id && node.data.kind === "image",
      );
      if (!target) {
        return;
      }
      selectCard(id);
      setImageWriterPrompt(target.data.imageGeneration?.prompt || "");
      if (target.data.imageGeneration) {
        const record = target.data.imageGeneration;
        setImageWriterSettings({
          model: selectedConfig("image") ? configValue(selectedConfig("image")!) : "",
          aspectRatio: record.aspectRatio,
          resolution: record.resolution,
          style: record.style,
          shot: record.shot,
          angle: record.angle,
          lens: record.lens,
          count: record.count,
        });
      }
      setImageWriterFeedback(null);
      setImageWriterFocusVersion((version) => version + 1);
    },
    [selectCard],
  );

  const updateImageWriterSettings = useCallback(
    (settings: ImageGenerationSettings) => {
      saveModelSelection("image", settings.model);
      const config = selectedConfig("image", settings.model);
      setImageWriterConfigured(Boolean(config?.configured));
      setImageWriterStatus(config?.configured ? "configured" : "unconfigured");
      setImageWriterProvider(config?.name || "请选择模型");
      setImageWriterSettings(settings);
      setImageWriterFeedback(null);
      accountStorage.setItem(IMAGE_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    },
    [],
  );

  const focusVideoWriter = useCallback(
    (id: string) => {
      const target = nodesRef.current.find(
        (node) => node.id === id && node.data.kind === "video",
      );
      if (!target) {
        return;
      }
      selectCard(id);
      setVideoWriterPrompt(target.data.videoGeneration?.prompt || "");
      if (target.data.videoGeneration) {
        const record = target.data.videoGeneration;
        setVideoWriterSettings({
          model: selectedConfig("video") ? configValue(selectedConfig("video")!) : "",
          aspectRatio: record.aspectRatio,
          resolution: "720p",
          duration: record.duration,
        });
      }
      setVideoWriterFeedback(null);
      setVideoWriterFocusVersion((version) => version + 1);
    },
    [selectCard],
  );

  const updateVideoWriterSettings = useCallback(
    (settings: VideoGenerationSettings) => {
      saveModelSelection("video", settings.model);
      const config = selectedConfig("video", settings.model);
      setVideoWriterConfigured(Boolean(config?.configured));
      setVideoWriterStatus(config?.configured ? "configured" : "unconfigured");
      setVideoWriterProvider(config?.name || "请选择模型");
      setVideoWriterSettings(settings);
      setVideoWriterFeedback(null);
      accountStorage.setItem(VIDEO_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    },
    [],
  );

  const optimizeCurrentImagePrompt = useCallback(async () => {
    const prompt = imageWriterPrompt.trim();
    const target = nodesRef.current.find(
      (node) => node.selected && node.data.kind === "image",
    );
    if (!prompt || !target || imageWriterBusy || imageWriterOptimizing) {
      return;
    }

    setImageWriterOptimizing(true);
    setImageWriterFeedback(null);
    try {
      const optimizedPrompt = await optimizeImagePrompt(prompt);
      setImageWriterPrompt(optimizedPrompt);
      setImageWriterFeedback({
        type: "success",
        text: "提示词已优化",
        nodeId: target.id,
      });
    } catch (error) {
      setImageWriterFeedback({
        type: "error",
        text: error instanceof Error ? error.message : "提示词优化失败",
        nodeId: target.id,
      });
    } finally {
      setImageWriterOptimizing(false);
    }
  }, [
    imageWriterBusy,
    imageWriterOptimizing,
    imageWriterPrompt,
  ]);

  const optimizeCurrentVideoPrompt = useCallback(async () => {
    const prompt = videoWriterPrompt.trim();
    const target = nodesRef.current.find(
      (node) => node.selected && node.data.kind === "video",
    );
    if (!prompt || !target || videoWriterBusy || videoWriterOptimizing) {
      return;
    }

    setVideoWriterOptimizing(true);
    setVideoWriterFeedback(null);
    try {
      const optimizedPrompt = await optimizeVideoPrompt(prompt);
      setVideoWriterPrompt(optimizedPrompt);
      setVideoWriterFeedback({
        type: "success",
        text: "提示词已优化",
        nodeId: target.id,
      });
    } catch (error) {
      setVideoWriterFeedback({
        type: "error",
        text: error instanceof Error ? error.message : "提示词优化失败",
        nodeId: target.id,
      });
    } finally {
      setVideoWriterOptimizing(false);
    }
  }, [
    videoWriterBusy,
    videoWriterOptimizing,
    videoWriterPrompt,
  ]);

  const removeCard = useCallback(
    (id: string) => {
      beginChange();
      setNodes((current) => current.filter((node) => node.id !== id));
      setEdges((current) =>
        current.filter((edge) => edge.source !== id && edge.target !== id),
      );
    },
    [beginChange],
  );

  const duplicateCard = useCallback(
    (id: string) => {
      const source = nodesRef.current.find((node) => node.id === id);
      if (!source) {
        return;
      }
      beginChange();
      const duplicate: CanvasNode = {
        ...source,
        id: createId(),
        position: {
          x: source.position.x + 32,
          y: source.position.y + 32,
        },
        selected: true,
        data: { ...source.data },
      };
      setNodes((current) => [
        ...current.map((node) => ({ ...node, selected: false })),
        duplicate,
      ]);
    },
    [beginChange],
  );

  const openAdjacentCardMenu = useCallback(
    (id: string, anchor: { x: number; y: number }) => {
      setAddMenuOpen(false);
      setContextMenu({
        sourceId: id,
        screenX: Math.max(8, Math.min(anchor.x, window.innerWidth - 184)),
        screenY: Math.max(8, Math.min(anchor.y, window.innerHeight - 174)),
        flowPosition: { x: 0, y: 0 },
      });
    },
    [],
  );

  const addFromContextMenu = (kind: CardKind) => {
    if (!contextMenu) return;
    if (!contextMenu.sourceId) {
      addCard(kind, "", contextMenu.flowPosition);
      setContextMenu(null);
      return;
    }
    const source = nodesRef.current.find((node) => node.id === contextMenu.sourceId);
    setContextMenu(null);
    if (!source) return;

    const size = cardSizes[kind];
    const sourceWidth = source.measured?.width || Number(source.style?.width) || cardSizes[source.data.kind].width;
    const position = { x: source.position.x + sourceWidth + 96, y: source.position.y };
    // Move to the next free column without disturbing existing cards.
    let overlapping: CanvasNode | undefined;
    while ((overlapping = nodesRef.current.find((node) => {
      const width = node.measured?.width || Number(node.style?.width) || cardSizes[node.data.kind].width;
      const height = node.measured?.height || Number(node.style?.height) || cardSizes[node.data.kind].height;
      return position.x < node.position.x + width + 24 &&
        position.x + size.width + 24 > node.position.x &&
        position.y < node.position.y + height + 24 &&
        position.y + size.height + 24 > node.position.y;
    }))) {
      const width = overlapping.measured?.width || Number(overlapping.style?.width) || cardSizes[overlapping.data.kind].width;
      position.x = overlapping.position.x + width + 96;
    }

    const newNode: CanvasNode = {
      id: createId(), type: "canvas-card", position, style: size,
      data: { kind, ...(kind === "text" ? { text: "" } : {}) }, selected: true,
    };
    const edge = createReferenceEdge(source.id, newNode.id);
    const supportsReference = kind === "text" ? source.data.kind === "text" :
      kind === "image" && (source.data.kind === "text" || source.data.kind === "image");
    // Other pairs express canvas order without claiming model reference support.
    if (!supportsReference) edge.data = { relation: "sequence" };
    beginChange();
    setNodes((current) => [...current.map((node) => ({ ...node, selected: false })), newNode]);
    setEdges((current) => [...current, edge]);
    requestAnimationFrame(() => {
      void reactFlow.fitView({ nodes: [source, newNode], padding: 0.3, maxZoom: 1, duration: 250 });
    });
  };

  const uploadMedia = useCallback(
    async (id: string, file: File) => {
      try {
      beginChange();
      const assetId = await saveMedia(file, projectId);
      const assetUrl = URL.createObjectURL(file);
      objectUrlsRef.current.add(assetUrl);
      updateCard(id, {
        assetId,
        assetUrl,
        fileName: file.name,
      });
      } catch (error) { window.alert(error instanceof Error ? error.message : "素材上传失败，请重试"); }
    },
    [beginChange, updateCard, projectId],
  );

  const requestTextRewrite = useCallback(
    (selection: TextRewriteSelection) => {
      if (textWriterBusy) {
        return;
      }

      setTextRewriteApplication(null);
      setTextRewriteSelection(selection);
      setTextWriterPrompt("");
      setTextWriterFeedback(null);
      setTextWriterUndo(null);
      setTextWriterFocusVersion((version) => version + 1);
    },
    [textWriterBusy],
  );

  const clearTextRewrite = useCallback(() => {
    if (textWriterBusy) {
      return;
    }
    setTextRewriteSelection(null);
    setTextRewriteApplication(null);
    setTextWriterFeedback(null);
  }, [textWriterBusy]);

  const completeTextRewrite = useCallback(
    (applicationId: string, error?: string) => {
      if (
        !textRewriteApplication ||
        textRewriteApplication.id !== applicationId
      ) {
        return;
      }

      setTextRewriteApplication(null);
      setTextRewriteSelection(null);

      if (error) {
        setTextWriterUndo(null);
        setTextWriterFeedback({
          type: "error",
          text: error,
          nodeId: textRewriteApplication.nodeId,
        });
        return;
      }

      setTextWriterFeedback({
        type: "success",
        text: `已改写 ${textRewriteApplication.replacement.length} 字`,
        nodeId: textRewriteApplication.nodeId,
      });
      setTextWriterPrompt("");
    },
    [textRewriteApplication],
  );

  const submitTextWriter = useCallback(async (referenceIds: string[] = []) => {
    const instruction = textWriterPrompt.trim();
    const selectedTextNodes = nodesRef.current.filter(
      (node) => node.selected && node.data.kind === "text",
    );
    const target = selectedTextNodes.length === 1 ? selectedTextNodes[0] : null;

    if (!instruction || !target || textWriterBusy) {
      return;
    }

    const rewriteTarget =
      textRewriteSelection?.nodeId === target.id
        ? textRewriteSelection
        : null;
    const requestId = textWriterRequestRef.current + 1;
    textWriterRequestRef.current = requestId;
    setTextWriterBusy(true);
    setTextWriterFeedback(null);

    try {
      const selectedReferenceIds = new Set(referenceIds.slice(0, 5));
      const references: TextReference[] = nodesRef.current
        .filter(
          (node) =>
            node.id !== target.id &&
            node.data.kind === "text" &&
            selectedReferenceIds.has(node.id) &&
            Boolean(node.data.text?.trim()),
        )
        .map((node) => ({
          id: node.id,
          text: node.data.text?.trim() || "",
        }));

      if (
        rewriteTarget &&
        (target.data.text || "") !== rewriteTarget.sourceMarkdown
      ) {
        throw new Error("当前文字已经发生变化，请重新选择要改写的内容");
      }

      const generated = rewriteTarget
        ? await rewriteTextSelection(
            instruction,
            {
              text: rewriteTarget.text,
              before: rewriteTarget.before,
              after: rewriteTarget.after,
            },
            textWriterModel,
            references,
          )
        : await generateTextForCard(
            instruction,
            target.data.text || "",
            textWriterModel,
            references,
          );
      if (textWriterRequestRef.current !== requestId) {
        return;
      }

      const latestTarget = nodesRef.current.find(
        (node) => node.id === target.id && node.data.kind === "text",
      );
      if (!latestTarget) {
        throw new Error("当前文字卡片已不存在");
      }

      const previousText = latestTarget.data.text || "";

      // Keep the user selection: a completed older task must not change it.
      if (rewriteTarget) {
        if (previousText !== rewriteTarget.sourceMarkdown) {
          throw new Error("当前文字已经发生变化，请重新选择要改写的内容");
        }

        setTextWriterUndo({
          nodeId: target.id,
          previousText,
          action: "改写",
        });
        setTextRewriteApplication({
          id: crypto.randomUUID(),
          nodeId: target.id,
          from: rewriteTarget.from,
          to: rewriteTarget.to,
          selectedText: rewriteTarget.text,
          replacement: generated.text,
        });
      } else {
        beginChange();
        updateCard(target.id, { text: generated.text });
        setTextWriterUndo({
          nodeId: target.id,
          previousText,
          action: "生成",
        });
        setTextWriterFeedback({
          type: "success",
          text: `已生成 ${generated.text.length} 字`,
          nodeId: target.id,
        });
        setTextWriterPrompt("");
      }
    } catch (error) {
      if (textWriterRequestRef.current === requestId) {
        setTextWriterFeedback({
          type: "error",
          text:
            error instanceof Error
              ? error.message
              : rewriteTarget
                ? "改写失败，请重试"
                : "生成失败，请重试",
          nodeId: target.id,
        });
      }
    } finally {
      if (textWriterRequestRef.current === requestId) {
        setTextWriterBusy(false);
      }
    }
  }, [
    beginChange,
    textWriterBusy,
    textWriterModel,
    textWriterPrompt,
    textRewriteSelection,
    updateCard,
  ]);

  const selectTextWriterModel = useCallback((model: string) => {
    saveModelSelection("text", model);
    setTextWriterModel(model);
    const config = selectedConfig("text", model);
    setTextWriterStatus(config?.configured ? "configured" : "unconfigured");
    setTextWriterProvider(config?.name || "请选择模型");
    setTextWriterFeedback(null);
    accountStorage.setItem(TEXT_MODEL_STORAGE_KEY, model);
  }, []);

  const undoTextWriter = useCallback(() => {
    if (!textWriterUndo) {
      return;
    }
    const target = nodesRef.current.find(
      (node) => node.id === textWriterUndo.nodeId,
    );
    if (!target) {
      setTextWriterUndo(null);
      return;
    }

    beginChange();
    updateCard(textWriterUndo.nodeId, {
      text: textWriterUndo.previousText,
    });
    setTextWriterFeedback({
      type: "success",
      text: `已撤销${textWriterUndo.action}`,
      nodeId: textWriterUndo.nodeId,
    });
    setTextWriterUndo(null);
  }, [beginChange, textWriterUndo, updateCard]);

  const submitImageWriter = useCallback(
    async (referenceIds: string[] = []) => {
      const prompt = imageWriterPrompt.trim();
      const selectedImageNodes = nodesRef.current.filter(
        (node) => node.selected && node.data.kind === "image",
      );
      const target =
        selectedImageNodes.length === 1 ? selectedImageNodes[0] : null;

      if (!prompt || !target || imageWriterBusy || !imageWriterConfigured) {
        return;
      }

      const requestId = imageWriterRequestRef.current + 1;
      imageWriterRequestRef.current = requestId;
      setImageWriterBusy(true);
      setImageWriterBusyNodeId(target.id);
      setImageWriterFeedback(null);

      const storedImages: Array<{
        assetId: string;
        assetUrl: string;
        fileName: string;
      }> = [];

      try {
        const selectedReferenceIds = new Set(referenceIds.slice(0, 5));
        const referenceNodes = nodesRef.current.filter(
          (node) =>
            node.id !== target.id &&
            selectedReferenceIds.has(node.id) &&
            ((node.data.kind === "text" && Boolean(node.data.text?.trim())) ||
              (node.data.kind === "image" &&
                Boolean(node.data.assetId || node.data.assetUrl))),
        );

        const references: ImageReference[] = [];
        for (const node of referenceNodes) {
          if (node.data.kind === "text") {
            references.push({
              id: node.id,
              kind: "text",
              label: `文字卡片：${(node.data.text || "").trim().slice(0, 40)}`,
              text: node.data.text?.trim() || "",
            });
            continue;
          }

          let dataUrl = "";
          if (node.data.assetId) {
            const media = await readMedia(node.data.assetId).catch(
              () => undefined,
            );
            if (media) {
              dataUrl = await blobToDataUrl(media.blob);
            }
          }
          if (!dataUrl && node.data.assetUrl) {
            dataUrl = await mediaUrlToDataUrl(node.data.assetUrl).catch(
              () => "",
            );
          }
          if (!dataUrl) {
            throw new Error(
              `参考图片“${node.data.fileName || "画布图片"}”无法从本机恢复，请重新添加`,
            );
          }
          references.push({
            id: node.id,
            kind: "image",
            label: node.data.fileName || "画布图片",
            dataUrl,
          });
        }

        const generated = await generateImages(
          prompt,
          imageWriterSettings,
          references,
        );
        if (imageWriterRequestRef.current !== requestId) {
          return;
        }

        const timeLabel = new Date()
          .toISOString()
          .replace(/[:.]/g, "-")
          .slice(0, 19);
        for (const [index, image] of generated.images.entries()) {
          const fileName = `漫金海-${timeLabel}-${index + 1}.png`;
          const file = image.assetId
            ? new File([await (await fetch(resolveApiUrl(image.previewUrl || image.dataUrl))).blob()], fileName, { type: "image/png" })
            : dataUrlToFile(image.dataUrl, fileName);
          const assetId = image.assetId || await saveMedia(file, projectId);
          if (image.assetId) {
            await registerProjectAsset({ projectId, assetId, kind: "image", fileName, createdAt: new Date().toISOString() });
          }
          const assetUrl = URL.createObjectURL(file);
          objectUrlsRef.current.add(assetUrl);
          storedImages.push({ assetId, assetUrl, fileName });
        }

        if (imageWriterRequestRef.current !== requestId) {
          await Promise.all(
            storedImages.map((image) => deleteMedia(image.assetId)),
          );
          storedImages.forEach((image) => {
            URL.revokeObjectURL(image.assetUrl);
            objectUrlsRef.current.delete(image.assetUrl);
          });
          return;
        }

        const latestTarget = nodesRef.current.find(
          (node) => node.id === target.id && node.data.kind === "image",
        );
        if (!latestTarget) {
          throw new Error("当前图片卡片已不存在");
        }

        const previousData = { ...latestTarget.data };
        const generatedAt = new Date().toISOString();
        const appliedSettings: ImageGenerationSettings = {
          ...imageWriterSettings,
          model: generated.model,
          count: storedImages.length,
        };
        const imageGeneration = {
          ...appliedSettings,
          prompt,
          referenceIds: references.map((reference) => reference.id),
          generatedAt,
        };
        const extraNodeIds = storedImages.slice(1).map(() => createId());
        const targetWidth =
          Number(latestTarget.style?.width) || cardSizes.image.width;

        beginChange();
        setNodes((current) => {
          const targetStillExists = current.some(
            (node) => node.id === target.id && node.data.kind === "image",
          );
          if (!targetStillExists) {
            return current;
          }

          const updated = current.map((node) =>
            node.id === target.id
              ? {
                  ...node,
                  selected: true,
                  data: {
                    ...node.data,
                    ...storedImages[0],
                    imageGeneration,
                  },
                }
              : { ...node, selected: false },
          );
          const extraNodes: CanvasNode[] = storedImages
            .slice(1)
            .map((image, index) => ({
              id: extraNodeIds[index],
              type: "canvas-card",
              position: {
                x:
                  latestTarget.position.x +
                  (targetWidth + 28) * (index + 1),
                y: latestTarget.position.y,
              },
              style: {
                width: Number(latestTarget.style?.width) || cardSizes.image.width,
                height:
                  Number(latestTarget.style?.height) || cardSizes.image.height,
              },
              selected: false,
              data: {
                kind: "image",
                ...image,
                imageGeneration,
              },
            }));
          return [...updated, ...extraNodes];
        });
        // A completed task must not replace the current model selection.
        setImageWriterUndo({
          nodeId: target.id,
          previousData,
          createdNodeIds: extraNodeIds,
          generatedAssetIds: storedImages.map((image) => image.assetId),
          generatedAssetUrls: storedImages.map((image) => image.assetUrl),
        });
        setImageWriterFeedback({
          type: "success",
          text:
            storedImages.length > 1
              ? `已生成 ${storedImages.length} 张图片`
              : "图片已生成",
          nodeId: target.id,
        });
      } catch (error) {
        if (imageWriterRequestRef.current === requestId) {
          setImageWriterFeedback({
            type: "error",
            text: error instanceof Error ? error.message : "图片生成失败，请重试",
            nodeId: target.id,
          });
        }
        if (storedImages.length) {
          await Promise.all(
            storedImages.map((image) =>
              deleteMedia(image.assetId).catch(() => undefined),
            ),
          );
          storedImages.forEach((image) => {
            URL.revokeObjectURL(image.assetUrl);
            objectUrlsRef.current.delete(image.assetUrl);
          });
        }
      } finally {
        if (imageWriterRequestRef.current === requestId) {
          setImageWriterBusy(false);
          setImageWriterBusyNodeId(null);
        }
      }
    },
    [
      beginChange,
      imageWriterBusy,
      imageWriterConfigured,
      imageWriterPrompt,
      imageWriterSettings,
    ],
  );

  const undoImageWriter = useCallback(() => {
    if (!imageWriterUndo) {
      return;
    }
    const targetExists = nodesRef.current.some(
      (node) => node.id === imageWriterUndo.nodeId,
    );
    if (!targetExists) {
      setImageWriterUndo(null);
      return;
    }

    const createdIds = new Set(imageWriterUndo.createdNodeIds);
    beginChange();
    setNodes((current) =>
      current
        .filter((node) => !createdIds.has(node.id))
        .map((node) =>
          node.id === imageWriterUndo.nodeId
            ? {
                ...node,
                selected: true,
                data: { ...imageWriterUndo.previousData },
              }
            : node,
        ),
    );
    imageWriterUndo.generatedAssetUrls.forEach((url) => {
      URL.revokeObjectURL(url);
      objectUrlsRef.current.delete(url);
    });
    void Promise.all(
      imageWriterUndo.generatedAssetIds.map((assetId) =>
        deleteMedia(assetId).catch(() => undefined),
      ),
    );
    setImageWriterFeedback({
      type: "success",
      text: "已撤销图片生成",
      nodeId: imageWriterUndo.nodeId,
    });
    setImageWriterUndo(null);
  }, [beginChange, imageWriterUndo]);

  const submitVideoWriter = useCallback(async () => {
    const prompt = videoWriterPrompt.trim();
    const selectedVideoNodes = nodesRef.current.filter(
      (node) => node.selected && node.data.kind === "video",
    );
    const target =
      selectedVideoNodes.length === 1 ? selectedVideoNodes[0] : null;

    if (!prompt || !target || videoWriterBusy || !videoWriterConfigured) {
      return;
    }

    const requestId = videoWriterRequestRef.current + 1;
    videoWriterRequestRef.current = requestId;
    setVideoWriterBusy(true);
    setVideoWriterBusyNodeId(target.id);
    setVideoWriterFeedback(null);

    let storedVideo:
      | {
          assetId: string;
          assetUrl: string;
          fileName: string;
        }
      | undefined;

    try {
      const generated = await generateVideo(prompt, videoWriterSettings);
      if (videoWriterRequestRef.current !== requestId) {
        return;
      }

      const timeLabel = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .slice(0, 19);
      const fileName = `漫金海-${timeLabel}.mp4`;
      const file = new File([generated.blob], fileName, {
        type: generated.blob.type || "video/mp4",
      });
      const assetId = generated.assetId || await saveMedia(file, projectId);
      if (generated.assetId) {
        await registerProjectAsset({ projectId, assetId, kind: "video", fileName, createdAt: new Date().toISOString() });
      }
      const assetUrl = URL.createObjectURL(file);
      objectUrlsRef.current.add(assetUrl);
      storedVideo = { assetId, assetUrl, fileName };

      if (videoWriterRequestRef.current !== requestId) {
        await deleteMedia(assetId);
        URL.revokeObjectURL(assetUrl);
        objectUrlsRef.current.delete(assetUrl);
        return;
      }

      const latestTarget = nodesRef.current.find(
        (node) => node.id === target.id && node.data.kind === "video",
      );
      if (!latestTarget) {
        throw new Error("当前视频卡片已不存在");
      }

      const previousData = { ...latestTarget.data };
      const appliedSettings: VideoGenerationSettings = {
        ...videoWriterSettings,
        model: generated.model,
      };
      beginChange();
      updateCard(target.id, {
        ...storedVideo,
        videoGeneration: {
          ...appliedSettings,
          prompt,
          generatedAt: new Date().toISOString(),
          seconds: generated.seconds,
          size: generated.size,
        },
      });
        // A completed task must not replace the current model selection.
      setVideoWriterUndo({
        nodeId: target.id,
        previousData,
        generatedAssetId: assetId,
        generatedAssetUrl: assetUrl,
      });
      setVideoWriterFeedback({
        type: "success",
        text: "视频已生成",
        nodeId: target.id,
      });
    } catch (error) {
      if (videoWriterRequestRef.current === requestId) {
        setVideoWriterFeedback({
          type: error instanceof VideoCancelled ? "success" : "error",
          text: error instanceof Error ? error.message : "视频生成失败，请重试",
          nodeId: target.id,
        });
      }
      if (storedVideo) {
        await deleteMedia(storedVideo.assetId).catch(() => undefined);
        URL.revokeObjectURL(storedVideo.assetUrl);
        objectUrlsRef.current.delete(storedVideo.assetUrl);
      }
    } finally {
      if (videoWriterRequestRef.current === requestId) {
        setVideoWriterBusy(false);
        setVideoWriterBusyNodeId(null);
      }
    }
  }, [
    beginChange,
    updateCard,
    videoWriterBusy,
    videoWriterConfigured,
    videoWriterPrompt,
    videoWriterSettings,
  ]);

  const undoVideoWriter = useCallback(() => {
    if (!videoWriterUndo) {
      return;
    }
    const targetExists = nodesRef.current.some(
      (node) => node.id === videoWriterUndo.nodeId,
    );
    if (!targetExists) {
      setVideoWriterUndo(null);
      return;
    }

    beginChange();
    updateCard(videoWriterUndo.nodeId, {
      ...videoWriterUndo.previousData,
      assetId: videoWriterUndo.previousData.assetId,
      assetUrl: videoWriterUndo.previousData.assetUrl,
      fileName: videoWriterUndo.previousData.fileName,
      videoGeneration: videoWriterUndo.previousData.videoGeneration,
    });
    URL.revokeObjectURL(videoWriterUndo.generatedAssetUrl);
    objectUrlsRef.current.delete(videoWriterUndo.generatedAssetUrl);
    void deleteMedia(videoWriterUndo.generatedAssetId).catch(() => undefined);
    setVideoWriterFeedback({
      type: "success",
      text: "已撤销视频生成",
      nodeId: videoWriterUndo.nodeId,
    });
    setVideoWriterUndo(null);
  }, [beginChange, updateCard, videoWriterUndo]);

  const handleNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const handleEdgesChange = useCallback((changes: EdgeChange<CanvasEdge>[]) => {
    setEdges((current) => applyEdgeChanges(changes, current));
  }, []);

  const isValidReferenceConnection = useCallback((
    connection: Connection | CanvasEdge,
  ) => {
    const { source, target } = connection;
    if (!source || !target || source === target) {
      return false;
    }

    const sourceNode = nodesRef.current.find((node) => node.id === source);
    const targetNode = nodesRef.current.find((node) => node.id === target);
    if (!sourceNode || !targetNode) {
      return false;
    }

    const compatible =
      targetNode.data.kind === "text"
        ? sourceNode.data.kind === "text"
        : targetNode.data.kind === "image" &&
          (sourceNode.data.kind === "text" ||
            sourceNode.data.kind === "image");
    if (!compatible) {
      return false;
    }

    const incoming = edgesRef.current.filter((edge) => edge.target === target);
    return (
      incoming.length < MAX_REFERENCES &&
      !incoming.some((edge) => edge.source === source)
    );
  }, []);

  const connectReference = useCallback(
    (connection: Connection) => {
      if (
        !connection.source ||
        !connection.target ||
        !isValidReferenceConnection(connection)
      ) {
        return;
      }
      beginChange();
      setEdges((current) =>
        addEdge(
          createReferenceEdge(connection.source!, connection.target!),
          current,
        ),
      );
    },
    [beginChange, isValidReferenceConnection],
  );

  const removeReferenceEdge = useCallback(
    (edgeId: string) => {
      if (!edgesRef.current.some((edge) => edge.id === edgeId)) {
        return;
      }
      beginChange();
      setEdges((current) => current.filter((edge) => edge.id !== edgeId));
    },
    [beginChange],
  );

  const setTargetReferences = useCallback(
    (targetId: string, referenceIds: string[]) => {
      const target = nodesRef.current.find((node) => node.id === targetId);
      if (!target || target.data.kind === "video") {
        return;
      }

      const allowedIds = referenceIds
        .filter((sourceId) => {
          const source = nodesRef.current.find((node) => node.id === sourceId);
          if (!source || source.id === targetId) {
            return false;
          }
          return target.data.kind === "text"
            ? source.data.kind === "text"
            : source.data.kind === "text" || source.data.kind === "image";
        })
        .slice(0, MAX_REFERENCES);
      const currentIds = edgesRef.current
        .filter((edge) => edge.target === targetId && edge.data?.relation !== "sequence")
        .map((edge) => edge.source);

      if (
        currentIds.length === allowedIds.length &&
        currentIds.every((id) => allowedIds.includes(id))
      ) {
        return;
      }

      beginChange();
      setEdges((current) => [
        ...current.filter((edge) => edge.target !== targetId || edge.data?.relation === "sequence"),
        ...allowedIds.map((sourceId) =>
          createReferenceEdge(sourceId, targetId),
        ),
      ]);
    },
    [beginChange],
  );

  const handleMoveEnd = useCallback(
    (_event: MouseEvent | TouchEvent | null, nextViewport: Viewport) => {
      setViewportState(nextViewport);
    },
    [],
  );

  const executeAgentPlan = useCallback((plan: CanvasAgentPlan) => {
    const before = {nodes: snapshotNodes(nodesRef.current), edges: cloneEdges(edgesRef.current)};
    const center = reactFlow.screenToFlowPosition({x:window.innerWidth / 2,y:window.innerHeight / 2});
    const next = applyCanvasPlan(plan, before.nodes, before.edges, center, createId);
    beginChange();
    nodesRef.current = next.nodes;
    edgesRef.current = next.edges;
    setNodes(next.nodes);
    setEdges(next.edges);
    agentAfterFingerprint.current = canvasFingerprint(next.nodes, next.edges);
    requestAnimationFrame(() => void reactFlow.fitView({nodes:next.nodes.filter(node=>node.selected),padding:0.3,maxZoom:1,duration:260}));
    return before;
  }, [beginChange, reactFlow]);

  const completeAgentPlan = useCallback(
    (plan: CanvasAgentPlan, mode: CanvasAgentMode, notice?: string) => {
      const before = executeAgentPlan(plan);
      const messageId = createId();
      setAgentUndo({ messageId, snapshot: before });
      setMessages((current) => [
        ...current,
        {
          id: messageId,
          role: "assistant",
          text: "已完成：" + plan.actions.map(describeAction).join("；"),
          steps: ["计划已确认", "画布已更新"],
          mode,
          notice,
          undoable: true,
        },
      ]);
    },
    [executeAgentPlan],
  );

  const runAgentCommand = useCallback(async (instruction: string) => {
    const value = instruction.trim();
    if (!value || agentController.current) return;
    const controller = new AbortController();
    agentController.current = controller;
    const canvasId = activeCanvasIdRef.current;
    const fingerprint = canvasFingerprint(nodesRef.current, edgesRef.current);
    setMessages(current => [...current.map(message=>({...message,confirmation:false})), {id:createId(),role:"user",text:value}]);
    setComposer("");
    setAgentBusy(true);
    setPendingAgentPlan(null);
    try {
      const result = await planCanvasInstruction(value, nodesRef.current, {mode:agentSource,model:textWriterModels.includes(textWriterModel)?textWriterModel:undefined,edges:edgesRef.current,signal:controller.signal});
      if (controller.signal.aborted || canvasId !== activeCanvasIdRef.current) return;
      if (fingerprint !== canvasFingerprint(nodesRef.current,edgesRef.current)) throw new Error("规划期间画布已改变，请重新发送指令。");
      setAgentMode(result.mode);
      const needsReview = result.plan.actions.length > 0;
      if (needsReview) {
        pendingFingerprint.current = fingerprint;
        setPendingAgentPlan(result.plan);
      }
      setMessages(current=>[...current,{id:createId(),role:"assistant",text:result.plan.summary,mode:result.mode,notice:result.notice,confirmation:needsReview,plan:needsReview?result.plan:undefined}]);
    } catch(error) {
      setMessages(current=>[...current,{id:createId(),role:"assistant",text:error instanceof Error?error.message:"规划失败，画布未改变。"}]);
    } finally {
      agentController.current = null;
      setAgentBusy(false);
    }
  }, [agentSource,textWriterModel,textWriterModels]);

  useEffect(() => {
    const container = messagesEnd.current?.parentElement;
    if (assistantOpen && container) container.scrollTo({top: container.scrollHeight, behavior:"smooth"});
  }, [messages,agentBusy,assistantOpen]);
  useEffect(() => () => agentController.current?.abort(), []);

  const submitComposer = () => { void runAgentCommand(composer); };
  const confirmPendingAgentPlan = () => {
    if (!pendingAgentPlan) return;
    setMessages(current=>current.map(message=>({...message,confirmation:false})));
    if (pendingFingerprint.current !== canvasFingerprint(nodesRef.current,edgesRef.current)) {
      setPendingAgentPlan(null);
      setMessages(current=>[...current,{id:createId(),role:"assistant",text:"画布在规划后发生了变化，请重新规划，以免覆盖新内容。"}]);
      return;
    }
    completeAgentPlan(pendingAgentPlan,agentMode === "idle" ? "demo" : agentMode);
    setPendingAgentPlan(null);
  };
  const cancelPendingAgentPlan = () => {
    setPendingAgentPlan(null);
    setMessages(current=>[...current.map(message=>({...message,confirmation:false})),{id:createId(),role:"assistant",text:"已取消，画布保持原样。"}]);
  };
  const undoAgentOperation = (messageId: string) => {
    if (!agentUndo || agentUndo.messageId !== messageId) return;
    if (agentAfterFingerprint.current !== canvasFingerprint(nodesRef.current,edgesRef.current)) {
      setMessages(current=>[...current,{id:createId(),role:"assistant",text:"之后还有其他编辑。请先使用顶部撤销逐步回退，避免覆盖这些修改。"}]);
      return;
    }
    beginChange();
    const restored = cloneCanvasSnapshot(agentUndo.snapshot);
    nodesRef.current = restored.nodes;
    edgesRef.current = restored.edges;
    setNodes(restored.nodes);
    setEdges(restored.edges);
    setAgentUndo(null);
    setMessages(current=>[...current,{id:createId(),role:"assistant",text:"已撤销本次操作，卡片和引用关系已恢复。"}]);
  };

  const nodeTypes = useMemo(
    () => ({
      "canvas-card": CanvasCard,
    }),
    [],
  );
  const edgeTypes = useMemo(
    () => ({
      reference: ReferenceEdge,
    }),
    [],
  );

  const actions = useMemo(
    () => ({
      beginChange,
      selectCard,
      updateCard,
      removeCard,
      removeReference: removeReferenceEdge,
      duplicateCard,
      uploadMedia,
      recoverMedia,
      imageBusyNodeId: imageWriterBusyNodeId,
      videoBusyNodeId: videoWriterBusyNodeId,
      focusImageWriter,
      focusVideoWriter,
      openAdjacentCardMenu,
      adjacentCardMenuId: contextMenu?.sourceId,
      rewriteApplication: textRewriteApplication,
      rewriteBusy: textWriterBusy,
      requestTextRewrite,
      completeTextRewrite,
    }),
    [
      beginChange,
      openAdjacentCardMenu,
      contextMenu?.sourceId,
      completeTextRewrite,
      duplicateCard,
      focusImageWriter,
      focusVideoWriter,
      imageWriterBusyNodeId,
      removeCard,
      removeReferenceEdge,
      recoverMedia,
      requestTextRewrite,
      selectCard,
      textRewriteApplication,
      textWriterBusy,
      updateCard,
      uploadMedia,
      videoWriterBusyNodeId,
    ],
  );

  const canUndo = pastRef.current.length > 0;
  const canRedo = futureRef.current.length > 0;
  const selectedCount = nodes.filter((node) => node.selected).length;
  const selectedTextNodes = nodes.filter(
    (node) => node.selected && node.data.kind === "text",
  );
  const activeTextNode =
    selectedTextNodes.length === 1 ? selectedTextNodes[0] : null;
  const selectedImageNodes = nodes.filter(
    (node) => node.selected && node.data.kind === "image",
  );
  const activeImageNode =
    selectedImageNodes.length === 1 ? selectedImageNodes[0] : null;
  const activeImageNodeId = activeImageNode?.id;
  const selectedVideoNodes = nodes.filter(
    (node) => node.selected && node.data.kind === "video",
  );
  const activeVideoNode =
    selectedVideoNodes.length === 1 ? selectedVideoNodes[0] : null;
  const activeVideoNodeId = activeVideoNode?.id;
  const activeTextReferenceIds = activeTextNode
    ? edges
        .filter((edge) => edge.target === activeTextNode.id && edge.data?.relation !== "sequence")
        .map((edge) => edge.source)
    : [];
  const activeImageReferenceIds = activeImageNode
    ? edges
        .filter((edge) => edge.target === activeImageNode.id && edge.data?.relation !== "sequence")
        .map((edge) => edge.source)
    : [];

  useEffect(() => {
    if (
      textRewriteSelection &&
      activeTextNode?.id !== textRewriteSelection.nodeId
    ) {
      setTextRewriteSelection(null);
      setTextRewriteApplication(null);
    }
  }, [activeTextNode?.id, textRewriteSelection]);

  useEffect(() => {
    if (!activeImageNodeId) {
      return;
    }
    const target = nodesRef.current.find(
      (node) => node.id === activeImageNodeId && node.data.kind === "image",
    );
    if (!target) {
      return;
    }
    setImageWriterPrompt(target.data.imageGeneration?.prompt || "");
    if (target.data.imageGeneration) {
      const record = target.data.imageGeneration;
      const settings = {
        model: selectedConfig("image") ? configValue(selectedConfig("image")!) : "",
        aspectRatio: record.aspectRatio,
        resolution: record.resolution,
        style: record.style,
        shot: record.shot,
        angle: record.angle,
        lens: record.lens,
        count: record.count,
      };
      saveModelSelection("image", settings.model);
      const config = selectedConfig("image", settings.model);
      setImageWriterConfigured(Boolean(config?.configured));
      setImageWriterStatus(config?.configured ? "configured" : "unconfigured");
      setImageWriterProvider(config?.name || "请选择模型");
      setImageWriterSettings(settings);
      accountStorage.setItem(
        IMAGE_SETTINGS_STORAGE_KEY,
        JSON.stringify(settings),
      );
    }
  }, [activeImageNodeId]);

  useEffect(() => {
    if (!activeVideoNodeId) {
      return;
    }
    const target = nodesRef.current.find(
      (node) => node.id === activeVideoNodeId && node.data.kind === "video",
    );
    if (!target) {
      return;
    }
    setVideoWriterPrompt(target.data.videoGeneration?.prompt || "");
    if (target.data.videoGeneration) {
      const record = target.data.videoGeneration;
      const settings: VideoGenerationSettings = {
        model: selectedConfig("video") ? configValue(selectedConfig("video")!) : "",
        aspectRatio: record.aspectRatio,
        resolution: "720p",
        duration: record.duration,
      };
      saveModelSelection("video", settings.model);
      const config = selectedConfig("video", settings.model);
      setVideoWriterConfigured(Boolean(config?.configured));
      setVideoWriterStatus(config?.configured ? "configured" : "unconfigured");
      setVideoWriterProvider(config?.name || "请选择模型");
      setVideoWriterSettings(settings);
      accountStorage.setItem(
        VIDEO_SETTINGS_STORAGE_KEY,
        JSON.stringify(settings),
      );
    }
  }, [activeVideoNodeId]);

  const textReferenceOptions: TextReference[] = activeTextNode
    ? nodes
        .filter(
          (node) =>
            node.id !== activeTextNode.id &&
            node.data.kind === "text" &&
            Boolean(node.data.text?.trim()),
        )
        .map((node) => ({
          id: node.id,
          text: node.data.text?.trim() || "",
        }))
    : [];
  const imageReferenceOptions: ImageReferenceOption[] = activeImageNode
    ? nodes.flatMap<ImageReferenceOption>((node): ImageReferenceOption[] => {
        if (node.id === activeImageNode.id) {
          return [];
        }
        if (node.data.kind === "text" && node.data.text?.trim()) {
          return [
            {
              id: node.id,
              kind: "text" as const,
              label: node.data.text.trim().replace(/\s+/g, " ").slice(0, 80),
            },
          ];
        }
        if (
          node.data.kind === "image" &&
          (node.data.assetId || node.data.assetUrl)
        ) {
          return [
            {
              id: node.id,
              kind: "image" as const,
              label:
                node.data.fileName ||
                node.data.imageGeneration?.prompt.slice(0, 80) ||
                "画布图片",
              assetUrl: node.data.assetUrl,
            },
          ];
        }
        return [];
      })
    : [];
  const activeCanvas =
    canvases.find((canvas) => canvas.id === activeCanvasId) || canvases[0];
  void historyVersion;

  return (
    <div
      className={[
        "app-shell",
        assistantOpen ? "assistant-is-open" : "",
        activeTextNode ? "text-writer-is-open" : "",
        activeImageNode ? "image-writer-is-open" : "",
        activeVideoNode ? "video-writer-is-open" : "",
        canvasListOpen ? "canvas-list-is-open" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <header className="topbar">
        <div className="brand">
          {!canvasListOpen && (
            <button
              className="canvas-sidebar-toggle"
              type="button"
              onClick={() => setCanvasListOpen(true)}
              title="打开画布列表"
            >
              <PanelLeftOpen size={17} strokeWidth={1.8} />
            </button>
          )}
          <button className="brand-home-button" type="button" onClick={onHome} title="返回主页" aria-label="返回主页">
            <img src="/logo-manjinhai.png" alt="" />
            <span className="brand-name">漫金海</span>
          </button>
          <span className="brand-divider" />
          <span className="brand-product">画布</span>
        </div>

        <div className="project-location">
          <div className="project-title-wrap">
            <input
              value={projectTitle}
              aria-label="项目名称"
              onChange={(event) => setProjectTitle(event.target.value)}
            />
          </div>
          <span className="project-location-separator">/</span>
          <button
            className="active-canvas-button"
            type="button"
            onClick={() => setCanvasListOpen(true)}
            title="打开画布列表"
          >
            <span>{activeCanvas.title}</span>
            <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>

        <div className="topbar-actions"><SourceFooter/><AccountButton/>
          <button
            className="model-manager-trigger"
            type="button"
            aria-controls="model-manager-panel"
            aria-expanded={modelManagerOpen}
            onClick={() => setModelManagerOpen(true)}
            title="模型管理"
          >
            <Cpu size={16} strokeWidth={1.8} />
            <span>模型</span>
          </button>
          <div className="history-controls">
            <button
              type="button"
              disabled={!canUndo}
              onClick={undo}
              title="撤销"
            >
              <Undo2 size={17} strokeWidth={1.75} />
            </button>
            <button
              type="button"
              disabled={!canRedo}
              onClick={redo}
              title="重做"
            >
              <Redo2 size={17} strokeWidth={1.75} />
            </button>
          </div>
          <span className={`save-state save-state-${saveState}`}>
            {saveState === "error" ? (
              <X size={14} strokeWidth={2} />
            ) : (
              <Check size={14} strokeWidth={2} />
            )}
            {saveState === "saved"
              ? "已保存至本机"
              : saveState === "error"
                ? "保存失败"
                : "保存中"}
          </span>
        </div>
      </header>

      <ModelManager
        open={modelManagerOpen}
        onClose={closeModelManager}
        catalog={modelCatalog}
        connectionError={modelConnectionError}
        onRefresh={refreshModels}
        groups={[
          {
            id: "text",
            title: "文字模型",
            description: "用于文字卡片生成与局部改写",
            provider: textWriterProvider,
            status: textWriterStatus,
            selectedModel: textWriterModel,
            models: textWriterModels,
            onModelChange: selectTextWriterModel,
          },
          {
            id: "image",
            title: "图片模型",
            description: "用于图片卡片生成",
            provider: imageWriterProvider,
            status: imageWriterStatus,
            selectedModel: imageWriterSettings.model,
            models: imageWriterModels,
            onModelChange: (model) =>
              updateImageWriterSettings({ ...imageWriterSettings, model }),
          },
          {
            id: "video",
            title: "视频模型",
            description: "用于视频卡片生成",
            provider: videoWriterProvider,
            status: videoWriterStatus,
            selectedModel: videoWriterSettings.model,
            models: videoWriterModels,
            note:
              videoWriterModels.length <= 1
                ? "当前仅有一个可选视频模型；队列拥堵时仍需稍后重试。"
                : undefined,
            onModelChange: (model) =>
              updateVideoWriterSettings({ ...videoWriterSettings, model }),
          },
        ]}
      />

      {canvasListOpen && (
        <CanvasSidebar
          canvases={canvases}
          activeCanvasId={activeCanvasId}
          onClose={() => setCanvasListOpen(false)}
          onCreate={createCanvas}
          onSelect={switchCanvas}
          onRename={renameCanvas}
          onDuplicate={duplicateCanvas}
          onDelete={deleteCanvas}
          onReorder={reorderCanvases}
          nodes={nodes}
          onSelectNode={(id) => { selectCard(id); const node=nodes.find(item=>item.id===id); if(node) void reactFlow.fitView({nodes:[node],padding:0.8,maxZoom:1,duration:300}); if(window.innerWidth<760) setCanvasListOpen(false); }}
        />
      )}

      {tidyPreview && <div className="tidy-preview-overlay"><section role="dialog" aria-modal="true" aria-label="整理结果确认" className="tidy-preview-confirm">
        <strong>是否保留此次整理结果？</strong><p>已按连线关系排列，内容和连线保持不变</p>
        <div><button type="button" onClick={() => { void reactFlow.setViewport(tidyPreview.originalViewport); setViewportState(tidyPreview.originalViewport); setTidyPreview(null); }}>还原</button>
        <button type="button" className="tidy-keep" onClick={() => { beginChange(); setNodes(tidyPreview.nodes); setTidyPreview(null); }}>保留</button></div>
      </section></div>}
      <main className="canvas-region">
        <CanvasActionsContext.Provider value={actions}>
          <ReactFlow
            nodes={tidyPreview?.nodes || nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={tidyPreview ? undefined : handleNodesChange}
            onEdgesChange={handleEdgesChange}
            onConnect={connectReference}
            isValidConnection={isValidReferenceConnection}
            connectionLineStyle={{ stroke: "#999999", strokeWidth: 1.5 }}
            snapToGrid={snapToGrid}
            snapGrid={[CANVAS_GRID_SIZE,CANVAS_GRID_SIZE]}
            onNodeDragStart={beginChange}
            onMoveEnd={handleMoveEnd}
            defaultViewport={initialCanvas.viewport}
            minZoom={0.25}
            maxZoom={2}
            panOnScroll
            panOnScrollSpeed={1}
            zoomOnPinch
            zoomOnScroll={false}
            selectionOnDrag
            deleteKeyCode={null}
            proOptions={{ hideAttribution: true }}
            onPaneClick={() => { setContextMenu(null); setAddMenuOpen(false); }}
            onMoveStart={() => setContextMenu(null)}
            onPaneContextMenu={(event) => {
              event.preventDefault();
              const menuWidth = 176;
              const menuHeight = 166;
              setContextMenu({
                screenX: Math.min(event.clientX, window.innerWidth - menuWidth - 10),
                screenY: Math.min(event.clientY, window.innerHeight - menuHeight - 10),
                flowPosition: reactFlow.screenToFlowPosition({
                  x: event.clientX,
                  y: event.clientY,
                }),
              });
            }}
            onDoubleClick={(event) => {
              if ((event.target as HTMLElement).classList.contains("react-flow__pane")) {
                addCard(
                  "text",
                  "",
                  reactFlow.screenToFlowPosition({
                    x: event.clientX,
                    y: event.clientY,
                  }),
                );
              }
            }}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={CANVAS_GRID_SIZE}
              size={1.2}
              color={snapToGrid ? "#cecece" : "#e8e8e8"}
            />
            {miniMapOpen && <MiniMap position="bottom-left" pannable zoomable nodeColor="#e7e7e7" maskColor="rgba(250,250,250,.65)" nodeBorderRadius={4} ariaLabel="画布小地图" />}
          </ReactFlow>
        </CanvasActionsContext.Provider>

        {!activeTextNode && !activeImageNode && !activeVideoNode && (
          <div className="canvas-tip">
            双击创建文字 · 拖动连接点建立引用
          </div>
        )}

        <div className="zoom-controls">
          <button type="button" title="整理画布" disabled={canvasInteractionBusy || nodes.length < 2} onClick={() => { const previewNodes = tidyCanvas(nodesRef.current, edgesRef.current); setTidyPreview({nodes:previewNodes,originalViewport:reactFlow.getViewport()}); requestAnimationFrame(() => void reactFlow.fitView({nodes:previewNodes,padding:0.25,maxZoom:1,duration:250})); }}><LayoutGrid size={16} /></button>
          <button type="button" title="画布小地图" aria-pressed={miniMapOpen} onClick={() => setMiniMapOpen(open=>!open)}><MapIcon size={16} /></button>
          <button type="button" title="网格吸附" aria-pressed={snapToGrid} onClick={() => setSnapToGrid(value=>!value)}><Magnet size={16} /></button>
          <span className="tool-divider" />
          <span className="zoom-value">{Math.round(viewport.zoom*100)}%</span>
          <button
            type="button"
            onClick={() => reactFlow.zoomOut({ duration: 180 })}
            title="缩小"
          >
            <Minus size={16} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={() => reactFlow.fitView({ padding: 0.18, duration: 260 })}
            title="适应画布"
          >
            <Maximize2 size={15} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={() => reactFlow.zoomIn({ duration: 180 })}
            title="放大"
          >
            <Plus size={16} strokeWidth={1.75} />
          </button>
        </div>
      </main>
        <div className="canvas-bottom-tools">
          {addMenuOpen && <div className="node-add-popover" role="menu" aria-label="添加节点">
            <span>添加节点</span>
            <button role="menuitem" type="button" onClick={()=>{addCard("text");setAddMenuOpen(false);}}><FileText size={18}/>文字</button>
            <button role="menuitem" type="button" onClick={()=>{addCard("image");setAddMenuOpen(false);}}><ImagePlus size={18}/>图片</button>
            <button role="menuitem" type="button" onClick={()=>{addCard("video");setAddMenuOpen(false);}}><Clapperboard size={18}/>视频</button>
          </div>}
          <button className="add-node-trigger" type="button" title="添加节点" aria-expanded={addMenuOpen} onClick={()=>setAddMenuOpen(open=>!open)}><Plus size={19}/></button>
          <ProjectAssetsButton onUse={useProjectAsset}/>
          <button type="button" title="快捷键" onClick={()=>setShortcutsOpen(true)}><Keyboard size={18}/></button>
          <span className="tool-divider"/>
          <button type="button" className={assistantOpen?"is-active":""} title="切换 Agent" aria-pressed={assistantOpen} onClick={()=>setAssistantOpen(open=>!open)}><Bot size={17}/><span>Agent</span></button>
        </div>

      {shortcutsOpen && <div className="shortcut-overlay" onClick={()=>setShortcutsOpen(false)}><section role="dialog" aria-modal="true" aria-label="画布操作指南" onClick={event=>event.stopPropagation()}><header><strong>画布操作指南</strong><button autoFocus type="button" aria-label="关闭操作指南" onClick={()=>setShortcutsOpen(false)}><X size={18}/></button></header><p>双击空白处 <kbd>新建文字</kbd></p><p>右键空白处 <kbd>添加节点</kbd></p><p>拖动画布空白处 <kbd>移动视图</kbd></p><p>双指滑动 / 鼠标滚轮 <kbd>平移画布</kbd></p><p>双指捏合 <kbd>缩放画布</kbd></p><p>拖动卡片连接点 <kbd>建立引用</kbd></p><p>Agent 输入框 <kbd>Enter 发送</kbd></p><p>Agent 输入框 <kbd>Shift + Enter 换行</kbd></p></section></div>}

      {contextMenu && (
        <div
          className="canvas-context-menu"
          role="menu"
          aria-label="添加节点"
          style={{
            left: contextMenu.screenX,
            top: contextMenu.screenY,
          }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <span className="context-menu-title">添加节点</span>
          <button autoFocus type="button" role="menuitem" onClick={() => addFromContextMenu("text")}>
            <FileText size={17} strokeWidth={1.75} />
            <span>文本</span>
          </button>
          <button type="button" role="menuitem" onClick={() => addFromContextMenu("image")}>
            <ImagePlus size={17} strokeWidth={1.75} />
            <span>图片</span>
          </button>
          <button type="button" role="menuitem" onClick={() => addFromContextMenu("video")}>
            <Clapperboard size={17} strokeWidth={1.75} />
            <span>视频</span>
          </button>
        </div>
      )}

      <button
        className="mobile-add-button"
        type="button"
        onClick={openMobileAddMenu}
        title="添加卡片"
      >
        <Plus size={19} strokeWidth={1.8} />
      </button>

      {activeTextNode && (
        <TextWriterDock
          key={activeTextNode.id}
          prompt={textWriterPrompt}
          modelName={textWriterModel}
          modelOptions={textWriterModels}
          referenceOptions={textReferenceOptions}
          initialReferenceIds={activeTextReferenceIds}
          busy={textWriterBusy}
          rewriteSelection={
            textRewriteSelection?.nodeId === activeTextNode.id
              ? textRewriteSelection
              : undefined
          }
          focusVersion={textWriterFocusVersion}
          feedback={
            textWriterFeedback?.nodeId === activeTextNode.id
              ? textWriterFeedback
              : undefined
          }
          canUndo={textWriterUndo?.nodeId === activeTextNode.id}
          undoLabel={`撤销${textWriterUndo?.action || "生成"}`}
          onPromptChange={setTextWriterPrompt}
          onModelChange={selectTextWriterModel}
          onReferencesChange={(referenceIds) =>
            setTargetReferences(activeTextNode.id, referenceIds)
          }
          onSubmit={(referenceIds) => void submitTextWriter(referenceIds)}
          onClearRewrite={clearTextRewrite}
          onUndo={undoTextWriter}
        />
      )}

      {activeImageNode && (
        <ImageWriterDock
          key={activeImageNode.id}
          prompt={imageWriterPrompt}
          settings={imageWriterSettings}
          modelOptions={imageWriterModels}
          referenceOptions={imageReferenceOptions}
          initialReferenceIds={activeImageReferenceIds}
          busy={imageWriterBusy}
          optimizing={imageWriterOptimizing}
          configured={imageWriterConfigured}
          focusVersion={imageWriterFocusVersion}
          feedback={
            imageWriterFeedback?.nodeId === activeImageNode.id
              ? imageWriterFeedback
              : undefined
          }
          canUndo={imageWriterUndo?.nodeId === activeImageNode.id}
          onPromptChange={setImageWriterPrompt}
          onSettingsChange={updateImageWriterSettings}
          onOptimize={() => void optimizeCurrentImagePrompt()}
          onReferencesChange={(referenceIds) =>
            setTargetReferences(activeImageNode.id, referenceIds)
          }
          onSubmit={(referenceIds) => void submitImageWriter(referenceIds)}
          onUndo={undoImageWriter}
        />
      )}

      {activeVideoNode && (
        <VideoWriterDock
          key={activeVideoNode.id}
          prompt={videoWriterPrompt}
          settings={videoWriterSettings}
          modelOptions={videoWriterModels}
          busy={videoWriterBusy}
          optimizing={videoWriterOptimizing}
          configured={videoWriterConfigured}
          focusVersion={videoWriterFocusVersion}
          feedback={
            videoWriterFeedback?.nodeId === activeVideoNode.id
              ? videoWriterFeedback
              : undefined
          }
          canUndo={videoWriterUndo?.nodeId === activeVideoNode.id}
          onPromptChange={setVideoWriterPrompt}
          onSettingsChange={updateVideoWriterSettings}
          onOptimize={() => void optimizeCurrentVideoPrompt()}
          onSubmit={() => void submitVideoWriter()}
          onUndo={undoVideoWriter}
          onCancel={cloudActive() ? () => cancelActiveVideo() : undefined}
        />
      )}

      <button
        className={`assistant-toggle ${assistantOpen ? "is-open" : ""}`}
        type="button"
        onClick={() => setAssistantOpen((open) => !open)}
        title={assistantOpen ? "收起画布助手" : "打开画布助手"}
      >
        {assistantOpen ? (
          <X size={18} strokeWidth={1.75} />
        ) : (
          <MessageCircle size={18} strokeWidth={1.75} />
        )}
      </button>

      <aside className={`assistant-panel ${assistantOpen ? "is-open" : ""}`} inert={!assistantOpen} aria-label="画布 Agent">
        <header className="assistant-header">
          <div className="assistant-mark">
            <Bot size={18} strokeWidth={1.75} />
          </div>
          <div>
            <h2>画布 Agent</h2>
            <p>
              {agentBusy
                ? "正在读取并操作画布"
                : agentMode === "ai"
                  ? "AI 模型已连接"
                  : agentMode === "demo"
                    ? "本地画布工具模式"
                    : "你的创作搭档"}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setAssistantOpen(false)}
            title="收起"
          >
            <X size={17} strokeWidth={1.75} />
          </button>
        </header>

        <div className="agent-quick-actions" aria-label="快捷画布操作">
          <button type="button" disabled={agentBusy} onClick={() => void runAgentCommand("读取画布，概览现有内容")}>画布概览</button>
          <button type="button" disabled={agentBusy || !nodes.some(n=>n.selected && n.data.kind === "text")} onClick={() => void runAgentCommand("将选中的剧本拆分成3个分镜，保留原文并引用来源")}>拆分分镜</button>
          <button
            type="button"
            disabled={agentBusy || nodes.length < 2}
            onClick={() => void runAgentCommand("把这些卡片横向排列")}
          >
            横向排列
          </button>
          <button
            type="button"
            disabled={agentBusy || selectedCount === 0}
            onClick={() => void runAgentCommand("复制选中卡片")}
          >
            复制选中
          </button>
        </div>

        <div className="assistant-messages" aria-live="polite">
          {messages.length === 1 && <div className="agent-welcome"><span><Bot size={25} strokeWidth={1.4}/></span><h3>一起，把故事变成画面</h3><p>读懂画布 · 拆解剧本 · 组织分镜</p><button type="button" onClick={()=>setComposer("创建3张文字卡片，分别描述故事的开场、转折和结尾")}>从一个故事开始 <ArrowUp size={14}/></button></div>}
          {messages.map((message) => (
            <div
              key={message.id}
              className={`assistant-message assistant-message-${message.role}`}
            >
              {message.role === "assistant" && (
                <span className="message-role">
                  画布 Agent
                  {message.mode && (
                    <em>{message.mode === "ai" ? "AI" : "本地工具"}</em>
                  )}
                </span>
              )}
              <p>{message.text}</p>
              {message.steps && (
                <ol className="agent-steps">
                  {message.steps.map((step, index) => (
                    <li key={`${message.id}-${index}`}>
                      <Check size={11} strokeWidth={2} />
                      {step}
                    </li>
                  ))}
                </ol>
              )}
              {message.notice && (
                <span className="agent-notice">{message.notice}</span>
              )}
              {message.plan && <div className="agent-plan-preview"><span className="plan-caption">{message.confirmation ? "待执行计划" : "计划记录"}</span>{message.plan.actions.map((action,index)=><div className="agent-plan-action" key={index}><strong>{index+1}. {describeAction(action)}</strong>{action.tool === "create_cards" && action.texts?.map((text,i)=><details key={i}><summary>卡片 {i+1} · {text.replace(/[#*\n]/g," ").slice(0,30)}</summary><p>{text}</p></details>)}{action.tool === "update_cards" && <details><summary>预览替换内容</summary><p>{action.text}</p></details>}</div>)}</div>}
              {message.confirmation && pendingAgentPlan && (
                <div className="agent-confirm-actions">
                  <button type="button" onClick={confirmPendingAgentPlan}>
                    确认执行
                  </button>
                  <button type="button" onClick={cancelPendingAgentPlan}>
                    取消
                  </button>
                </div>
              )}
              {message.undoable && agentUndo?.messageId === message.id && (
                <button
                  className="agent-undo"
                  type="button"
                  onClick={() => undoAgentOperation(message.id)}
                >
                  <RotateCcw size={13} strokeWidth={1.8} />
                  撤销本次操作
                </button>
              )}
            </div>
          ))}
          {agentBusy && (
            <div className="assistant-message assistant-message-assistant agent-working">
              <span className="message-role">画布 Agent</span>
              <p>
                <LoaderCircle size={15} strokeWidth={1.8} />
                正在读取画布并规划操作……
              </p>
            </div>
          )}
          <div ref={messagesEnd} />
        </div>

        <div className="agent-model-row"><select aria-label="Agent 运行模式" value={agentSource} disabled={agentBusy} onChange={event=>setAgentSource(event.target.value as CanvasAgentMode)}><option value="ai">AI 模型</option><option value="demo">本地工具</option></select>{agentSource === "ai" ? <select aria-label="Agent 模型" value={textWriterModel} disabled={agentBusy} onChange={event=>selectTextWriterModel(event.target.value)}>{(textWriterModels.length?textWriterModels:[textWriterModel]).map(model=><option key={model} value={model}>{modelLabel(model)}</option>)}</select> : <span>无需模型 · 不消耗额度</span>}</div>
        <div className="assistant-scope">
          <span className="scope-dot" />
          {activeCanvas.title} · 已读取 {nodes.length} 张卡片
          {selectedCount > 0 ? ` · 当前选中 ${selectedCount} 张` : " · 当前未选中"}
        </div>

        <form
          className="assistant-composer"
          onSubmit={(event) => {
            event.preventDefault();
            submitComposer();
          }}
        >
          <textarea
            value={composer}
            aria-label="Agent 指令"
            placeholder="描述你的想法，或让我整理画布…"
            disabled={agentBusy}
            onChange={(event) => setComposer(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submitComposer();
              }
            }}
          />
          <div className="composer-footer">
            <span>修改前预览 · 执行后可撤销</span>
            {agentBusy && <button type="button" title="停止规划" onClick={()=>agentController.current?.abort()}><Square size={13}/></button>}
            <button
              type="submit"
              disabled={!composer.trim() || agentBusy}
              title="执行"
            >
              {agentBusy ? (
                <LoaderCircle className="agent-spinner" size={15} strokeWidth={1.9} />
              ) : (
                <Send size={15} strokeWidth={1.9} />
              )}
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
}

export default function App() {
  return <ProjectManager legacy={readSavedProject} Workspace={CanvasWorkspace} />;
}
