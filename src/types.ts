import type { Edge, Node } from "@xyflow/react";

export type CardKind = "text" | "image" | "video";

export type ImageAspectRatio =
  | "adaptive"
  | "1:1"
  | "16:9"
  | "9:16"
  | "4:3"
  | "3:4";

export type ImageResolution = "1K" | "2K";

export type ImageGenerationSettings = {
  model: string;
  aspectRatio: ImageAspectRatio;
  resolution: ImageResolution;
  style: string;
  shot: string;
  angle: string;
  lens: string;
  count: number;
};

export type ImageGenerationRecord = ImageGenerationSettings & {
  prompt: string;
  referenceIds: string[];
  generatedAt: string;
};

export type VideoAspectRatio =
  | "adaptive"
  | "1:1"
  | "16:9"
  | "9:16"
  | "4:3"
  | "3:4";

export type VideoGenerationSettings = {
  model: string;
  aspectRatio: VideoAspectRatio;
  resolution: "720p";
  duration: 5 | 10;
};

export type VideoGenerationRecord = VideoGenerationSettings & {
  prompt: string;
  generatedAt: string;
  seconds: number;
  size: string;
};

export type PendingGeneration = {
  kind: "image" | "video";
  prompt: string;
  referenceIds?: string[];
  aspectRatio?: string;
  resolution?: ImageResolution;
  duration?: 5 | 10;
  proposedAt: string;
};

export type CanvasCardData = {
  kind: CardKind;
  text?: string;
  assetId?: string;
  assetUrl?: string;
  fileName?: string;
  imageGeneration?: ImageGenerationRecord;
  videoGeneration?: VideoGenerationRecord;
  pendingGeneration?: PendingGeneration;
};

export type CanvasNode = Node<CanvasCardData, "canvas-card">;

export type CanvasEdgeData = {
  relation: "reference" | "sequence";
};

export type CanvasEdge = Edge<CanvasEdgeData>;

export type TextRewriteSelection = {
  id: string;
  nodeId: string;
  from: number;
  to: number;
  text: string;
  before: string;
  after: string;
  sourceMarkdown: string;
};

export type TextRewriteApplication = {
  id: string;
  nodeId: string;
  from: number;
  to: number;
  selectedText: string;
  replacement: string;
};

export type SavedCanvas = {
  projectTitle: string;
  nodes: CanvasNode[];
  edges?: CanvasEdge[];
  viewport: {
    x: number;
    y: number;
    zoom: number;
  };
};

export type ProjectCanvas = {
  id: string;
  title: string;
  nodes: CanvasNode[];
  edges?: CanvasEdge[];
  viewport: {
    x: number;
    y: number;
    zoom: number;
  };
  createdAt: string;
  updatedAt: string;
};

export type SavedProject = {
  version: 2;
  projectTitle: string;
  activeCanvasId: string;
  canvases: ProjectCanvas[];
};
