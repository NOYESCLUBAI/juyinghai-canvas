import type { CanvasEdge, CanvasNode, CardKind, PendingGeneration } from "../types";
import { ASPECT_RATIOS, MAX_CREATES_PER_RUN, OVERVIEW_PREVIEW_CHARS, READ_CARD_CHARS, READ_TOOLS } from "./constants";
import { cardBaseHash } from "./hash";

const sizes: Record<CardKind, { width: number; height: number }> = {
  text: { width: 290, height: 190 },
  image: { width: 310, height: 250 },
  video: { width: 350, height: 250 },
};

export type ToolObservation = {
  ok: boolean;
  error?: string;
  message?: string;
  data?: Record<string, unknown>;
};

export type CanvasToolHost = {
  read(): { nodes: CanvasNode[]; edges: CanvasEdge[]; anchor: { x: number; y: number } };
  write(next: { nodes: CanvasNode[]; edges: CanvasEdge[] }): void;
  select(ids: string[]): void;
  focus(target: { cardIds: string[] } | { fit: "all" }): void;
  createId(): string;
};

export type ToolRunContext = {
  host: CanvasToolHost;
  permission: "balanced" | "confirm";
  instruction: string;
  createsThisRun: number;
  shortByReal: Map<string, string>;
  realByShort: Map<string, string>;
  nextShort: number;
};

const ok = (data: Record<string, unknown> = {}): ToolObservation => ({ ok: true, data });
const fail = (error: string, message: string): ToolObservation => ({ ok: false, error, message });

export function syncShortIds(ctx: ToolRunContext) {
  for (const node of ctx.host.read().nodes) {
    if (ctx.shortByReal.has(node.id)) continue;
    ctx.nextShort += 1;
    const shortId = `n${ctx.nextShort}`;
    ctx.shortByReal.set(node.id, shortId);
    ctx.realByShort.set(shortId, node.id);
  }
}

export function createCountOf(input: unknown) {
  if (!input || typeof input !== "object") return 1;
  const record = input as Record<string, unknown>;
  if (Array.isArray(record.texts) && record.texts.length) return record.texts.length;
  if (Number.isInteger(record.count)) return Number(record.count);
  return 1;
}

export function duplicateCountOf(input: unknown) {
  if (!input || typeof input !== "object") return 0;
  const ids = (input as Record<string, unknown>).cardIds;
  return Array.isArray(ids) ? ids.length : 0;
}

export function toolNeedsUserApproval(name: string, input: unknown, ctx: Pick<ToolRunContext, "permission" | "createsThisRun">) {
  if (READ_TOOLS.has(name)) return false;
  if (name === "delete_cards" || name === "propose_generation") return true;
  if (name === "create_cards" && ctx.createsThisRun + createCountOf(input) > MAX_CREATES_PER_RUN) return true;
  if (name === "duplicate_cards" && ctx.createsThisRun + duplicateCountOf(input) > MAX_CREATES_PER_RUN) return true;
  return ctx.permission === "confirm";
}

function selectionBlocked(ctx: ToolRunContext) {
  if (!/选中|选择的/.test(ctx.instruction)) return null;
  if (ctx.host.read().nodes.some((node) => node.selected)) return null;
  return fail("selection_required", "请先选中卡片。未选中时不会改成全画布。");
}

function cloneNodes(nodes: CanvasNode[]) {
  return nodes.map((node) => ({
    ...node,
    position: { ...node.position },
    style: node.style ? { ...node.style } : undefined,
    data: { ...node.data },
  }));
}

function cloneEdges(edges: CanvasEdge[]): CanvasEdge[] {
  return edges.map((edge) => ({ ...edge, data: edge.data ? { ...edge.data } : undefined }));
}

function lookupId(id: unknown, ctx: ToolRunContext, nodes: CanvasNode[]): string | ToolObservation {
  if (typeof id !== "string" || !id) return fail("invalid_id", "卡片 id 无效。");
  const real = ctx.realByShort.get(id);
  if (real) return fail("short_id", `请使用真实 id ${real}，不要把短 id ${id} 写进操作。`);
  if (!nodes.some((node) => node.id === id)) return fail("unknown_id", `找不到卡片 ${id}。`);
  return id;
}

function idsOf(input: unknown, key: string, ctx: ToolRunContext, nodes: CanvasNode[], max: number) {
  if (!input || typeof input !== "object") return fail("invalid_input", "参数格式无效。");
  const value = (input as Record<string, unknown>)[key];
  if (!Array.isArray(value) || !value.length || value.length > max) return fail("invalid_input", `${key} 需要 1 到 ${max} 个 id。`);
  const ids: string[] = [];
  for (const item of value) {
    const resolved = lookupId(item, ctx, nodes);
    if (typeof resolved !== "string") return resolved;
    if (!ids.includes(resolved)) ids.push(resolved);
  }
  return ids;
}

function referenceAllowed(source: CanvasNode, target: CanvasNode) {
  if (source.id === target.id || target.data.kind === "video" || source.data.kind === "video") return false;
  if (target.data.kind === "text") return source.data.kind === "text";
  return source.data.kind === "text" || source.data.kind === "image";
}

function edge(source: string, target: string, relation: "reference" | "sequence"): CanvasEdge {
  return {
    id: `${relation}:${source}->${target}`,
    source,
    target,
    type: "reference",
    data: { relation },
    markerEnd: { type: "arrowclosed", color: "#999999", width: 16, height: 16 },
  };
}

function previewText(text: string | undefined) {
  return (text || "").replace(/\s+/g, " ").slice(0, OVERVIEW_PREVIEW_CHARS);
}

function publicCard(node: CanvasNode, ctx: ToolRunContext, edges: CanvasEdge[]) {
  return {
    id: node.id,
    shortId: ctx.shortByReal.get(node.id),
    kind: node.data.kind,
    text: (node.data.text || "").slice(0, READ_CARD_CHARS),
    baseHash: cardBaseHash(node),
    preview: previewText(node.data.text),
    position: node.position,
    selected: !!node.selected,
    hasMedia: !!(node.data.assetId || node.data.assetUrl),
    fileName: node.data.fileName,
    imageGeneration: node.data.imageGeneration,
    videoGeneration: node.data.videoGeneration,
    pendingGeneration: node.data.pendingGeneration,
    links: edges
      .filter((item) => item.source === node.id || item.target === node.id)
      .map((item) => ({ source: item.source, target: item.target, relation: item.data?.relation || "reference" })),
  };
}

function belowOrigin(nodes: CanvasNode[], anchor: { x: number; y: number }) {
  if (!nodes.length) return anchor;
  const bottom = Math.max(...nodes.map((node) => node.position.y + (Number(node.style?.height) || sizes[node.data.kind].height)));
  return { x: anchor.x, y: bottom + 64 };
}

export function executeCanvasTool(name: string, input: unknown, ctx: ToolRunContext): { observation: ToolObservation; wrote: boolean; cardIds: string[] } {
  syncShortIds(ctx);
  const snapshot = ctx.host.read();
  const none = (observation: ToolObservation) => ({ observation, wrote: false, cardIds: [] as string[] });
  if (name === "finish") {
    const summary = input && typeof input === "object" ? String((input as Record<string, unknown>).summary || "") : "";
    if (!summary.trim()) return none(fail("invalid_input", "结束时需要一段总结。"));
    return none(ok({ summary: summary.slice(0, 1500) }));
  }
  if (!READ_TOOLS.has(name)) {
    const blocked = selectionBlocked(ctx);
    if (blocked) return none(blocked);
  }
  if (name === "canvas_overview") return none(overview(input, ctx, snapshot.nodes, snapshot.edges));
  if (name === "read_cards") return none(readCards(input, ctx, snapshot.nodes, snapshot.edges));
  if (name === "search_cards") return none(searchCards(input, snapshot.nodes, ctx));
  if (name === "select_cards") return selectCards(input, ctx, snapshot.nodes);
  if (name === "focus_viewport") return focusViewport(input, ctx, snapshot.nodes);
  if (name === "create_cards") return createCards(input, ctx, snapshot);
  if (name === "update_text") return updateText(input, ctx, snapshot);
  if (name === "move_cards") return moveCards(input, ctx, snapshot);
  if (name === "arrange_cards") return arrangeCards(input, ctx, snapshot);
  if (name === "duplicate_cards") return duplicateCards(input, ctx, snapshot);
  if (name === "delete_cards") return deleteCards(input, ctx, snapshot);
  if (name === "connect_cards") return connectCards(input, ctx, snapshot);
  if (name === "disconnect_cards") return disconnectCards(input, ctx, snapshot);
  if (name === "propose_generation") return proposeGeneration(input, ctx, snapshot);
  return none(fail("unknown_tool", `不支持的工具 ${name}，画布未改变。`));
}

function overview(input: unknown, ctx: ToolRunContext, nodes: CanvasNode[], edges: CanvasEdge[]): ToolObservation {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const offset = Number.isInteger(record.offset) ? Math.max(0, Number(record.offset)) : 0;
  const limit = Number.isInteger(record.limit) ? Math.min(50, Math.max(1, Number(record.limit))) : 50;
  const page = nodes.slice(offset, offset + limit);
  const degree = (id: string) => edges.filter((edgeItem) => edgeItem.source === id || edgeItem.target === id).length;
  return ok({
    total: nodes.length,
    offset,
    limit,
    selectedIds: nodes.filter((node) => node.selected).map((node) => node.id),
    shortIds: nodes.map((node) => ({ shortId: ctx.shortByReal.get(node.id), id: node.id })),
    cards: page.map((node) => ({
      id: node.id,
      shortId: ctx.shortByReal.get(node.id),
      kind: node.data.kind,
      preview: previewText(node.data.text),
      position: node.position,
      selected: !!node.selected,
      hasMedia: !!(node.data.assetId || node.data.assetUrl),
      degree: degree(node.id),
    })),
  });
}

function readCards(input: unknown, ctx: ToolRunContext, nodes: CanvasNode[], edges: CanvasEdge[]): ToolObservation {
  const ids = idsOf(input, "cardIds", ctx, nodes, 8);
  if (!Array.isArray(ids)) return ids;
  return ok({ cards: ids.map((id) => publicCard(nodes.find((node) => node.id === id)!, ctx, edges)) });
}

function searchCards(input: unknown, nodes: CanvasNode[], ctx: ToolRunContext): ToolObservation {
  if (!input || typeof input !== "object") return fail("invalid_input", "搜索参数无效。");
  const record = input as Record<string, unknown>;
  const query = typeof record.query === "string" ? record.query.trim() : "";
  if (!query || query.length > 200) return fail("invalid_input", "搜索词需要 1 到 200 字。");
  if (record.kind !== undefined && !["text", "image", "video"].includes(String(record.kind))) return fail("invalid_input", "kind 只能是 text、image 或 video。");
  const limit = Number.isInteger(record.limit) ? Math.min(20, Math.max(1, Number(record.limit))) : 20;
  const needle = query.toLowerCase();
  const matches = nodes.filter((node) => {
    if (record.kind && node.data.kind !== record.kind) return false;
    return (node.data.text || "").toLowerCase().includes(needle);
  }).slice(0, limit);
  return ok({
    matches: matches.map((node) => {
      const text = node.data.text || "";
      const at = text.toLowerCase().indexOf(needle);
      const from = Math.max(0, at - 40);
      return {
        id: node.id,
        shortId: ctx.shortByReal.get(node.id),
        kind: node.data.kind,
        snippet: text.slice(from, from + query.length + 80),
      };
    }),
  });
}

function selectCards(input: unknown, ctx: ToolRunContext, nodes: CanvasNode[]) {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const requested = Array.isArray(record.cardIds) ? record.cardIds : [];
  if (!requested.length) {
    ctx.host.select([]);
    return { observation: ok({ selectedIds: [] }), wrote: false, cardIds: [] };
  }
  const ids = idsOf({ cardIds: requested }, "cardIds", ctx, nodes, 40);
  if (!Array.isArray(ids)) return { observation: ids, wrote: false, cardIds: [] };
  ctx.host.select(ids);
  return { observation: ok({ selectedIds: ids }), wrote: false, cardIds: ids };
}

function focusViewport(input: unknown, ctx: ToolRunContext, nodes: CanvasNode[]) {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  if (record.fit === "all") {
    ctx.host.focus({ fit: "all" });
    return { observation: ok({ fit: "all" }), wrote: false, cardIds: [] };
  }
  const ids = idsOf(record, "cardIds", ctx, nodes, 40);
  if (!Array.isArray(ids)) return { observation: ids, wrote: false, cardIds: [] };
  ctx.host.focus({ cardIds: ids });
  return { observation: ok({ cardIds: ids }), wrote: false, cardIds: ids };
}

function createCards(input: unknown, ctx: ToolRunContext, snapshot: ReturnType<CanvasToolHost["read"]>) {
  if (!input || typeof input !== "object") return { observation: fail("invalid_input", "新建参数无效。"), wrote: false, cardIds: [] };
  const record = input as Record<string, unknown>;
  const cardType = record.cardType;
  if (cardType !== "text" && cardType !== "image" && cardType !== "video") return { observation: fail("invalid_input", "cardType 只能是 text、image 或 video。"), wrote: false, cardIds: [] };
  const texts = Array.isArray(record.texts) ? record.texts.map((text) => String(text).slice(0, READ_CARD_CHARS)) : undefined;
  const count = texts?.length || (Number.isInteger(record.count) ? Number(record.count) : 1);
  if (!Number.isInteger(count) || count < 1 || count > 12) return { observation: fail("invalid_input", "一次工具调用最多新建 12 张，超过 8 张需要确认。"), wrote: false, cardIds: [] };
  if (texts && texts.length !== count) return { observation: fail("invalid_input", "texts 的长度必须等于新建张数。"), wrote: false, cardIds: [] };
  if (cardType === "text" && !texts) return { observation: fail("invalid_input", "文字卡片必须提供 texts，且每张内容不同。"), wrote: false, cardIds: [] };
  if (cardType === "text" && texts && count > 1 && new Set(texts).size === 1 && record.allowSameText !== true) {
    return { observation: fail("same_text", "多张分镜不能写成同一段文字。请分别写内容；若用户明确要求相同文字，设置 allowSameText 为 true。"), wrote: false, cardIds: [] };
  }
  const referenceIds = Array.isArray(record.referenceIds) ? idsOf({ cardIds: record.referenceIds }, "cardIds", ctx, snapshot.nodes, 5) : [];
  if (!Array.isArray(referenceIds)) return { observation: referenceIds, wrote: false, cardIds: [] };
  if (cardType === "video" && referenceIds.length) return { observation: fail("invalid_reference", "视频容器不能带引用。"), wrote: false, cardIds: [] };
  const sources = referenceIds.map((id) => snapshot.nodes.find((node) => node.id === id)!);
  if (sources.some((source) => !referenceAllowed(source, { ...source, id: "new", data: { kind: cardType } } as CanvasNode))) {
    return { observation: fail("invalid_reference", "文字只引用文字；图片可引用文字或图片，最多 5 张。视频不带引用。"), wrote: false, cardIds: [] };
  }
  const size = sizes[cardType];
  const position = record.position && typeof record.position === "object" ? record.position as Record<string, unknown> : null;
  const origin = position && Number.isFinite(position.x) && Number.isFinite(position.y)
    ? { x: Number(position.x), y: Number(position.y) }
    : belowOrigin(snapshot.nodes, snapshot.anchor);
  const columns = Math.min(3, count);
  const nodes = cloneNodes(snapshot.nodes).map((node) => ({ ...node, selected: false }));
  const edges = cloneEdges(snapshot.edges);
  const created: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = ctx.host.createId();
    created.push(id);
    nodes.push({
      id,
      type: "canvas-card",
      position: {
        x: origin.x + (index % columns) * (size.width + 32),
        y: origin.y + Math.floor(index / columns) * (size.height + 56),
      },
      style: { ...size },
      data: { kind: cardType, text: cardType === "text" ? texts?.[index] || "" : texts?.[index] },
      selected: true,
    });
    for (const source of referenceIds) edges.push(edge(source, id, "reference"));
  }
  ctx.host.write({ nodes, edges });
  ctx.createsThisRun += count;
  syncShortIds(ctx);
  return { observation: ok({ createdIds: created, cardType, count }), wrote: true, cardIds: created };
}

function hashesMatch(node: CanvasNode, baseHash: unknown) {
  return typeof baseHash === "string" && baseHash === cardBaseHash(node);
}

function updateText(input: unknown, ctx: ToolRunContext, snapshot: ReturnType<CanvasToolHost["read"]>) {
  if (!input || typeof input !== "object" || !Array.isArray((input as Record<string, unknown>).updates)) {
    return { observation: fail("invalid_input", "update_text 需要 updates。"), wrote: false, cardIds: [] };
  }
  const updates = (input as { updates: unknown[] }).updates;
  if (!updates.length || updates.length > 8) return { observation: fail("invalid_input", "一次最多修改 8 张文字卡片。"), wrote: false, cardIds: [] };
  const parsed: { id: string; text: string }[] = [];
  for (const item of updates) {
    if (!item || typeof item !== "object") return { observation: fail("invalid_input", "修改项格式无效。"), wrote: false, cardIds: [] };
    const record = item as Record<string, unknown>;
    const id = lookupId(record.cardId, ctx, snapshot.nodes);
    if (typeof id !== "string") return { observation: id, wrote: false, cardIds: [] };
    const node = snapshot.nodes.find((candidate) => candidate.id === id)!;
    if (node.data.kind !== "text") return { observation: fail("invalid_target", "只能修改文字卡片。"), wrote: false, cardIds: [] };
    if (!hashesMatch(node, record.baseHash)) return { observation: fail("stale_base_hash", "卡片内容已变化，请重新 read_cards。这一步没有写入。"), wrote: false, cardIds: [] };
    if (typeof record.text !== "string") return { observation: fail("invalid_input", "text 必须是字符串。"), wrote: false, cardIds: [] };
    parsed.push({ id, text: record.text.slice(0, READ_CARD_CHARS) });
  }
  const byId = new Map(parsed.map((item) => [item.id, item.text]));
  const nodes = cloneNodes(snapshot.nodes).map((node) => byId.has(node.id) ? { ...node, data: { ...node.data, text: byId.get(node.id) }, selected: true } : { ...node, selected: false });
  ctx.host.write({ nodes, edges: cloneEdges(snapshot.edges) });
  return { observation: ok({ updatedIds: parsed.map((item) => item.id) }), wrote: true, cardIds: parsed.map((item) => item.id) };
}

function moveCards(input: unknown, ctx: ToolRunContext, snapshot: ReturnType<CanvasToolHost["read"]>) {
  if (!input || typeof input !== "object" || !Array.isArray((input as Record<string, unknown>).moves)) {
    return { observation: fail("invalid_input", "move_cards 需要 moves。"), wrote: false, cardIds: [] };
  }
  const moves = (input as { moves: unknown[] }).moves;
  if (!moves.length || moves.length > 40) return { observation: fail("invalid_input", "一次最多移动 40 张卡片。"), wrote: false, cardIds: [] };
  const parsed: { id: string; x: number; y: number }[] = [];
  for (const item of moves) {
    if (!item || typeof item !== "object") return { observation: fail("invalid_input", "移动项格式无效。"), wrote: false, cardIds: [] };
    const record = item as Record<string, unknown>;
    const id = lookupId(record.cardId, ctx, snapshot.nodes);
    if (typeof id !== "string") return { observation: id, wrote: false, cardIds: [] };
    if (!Number.isFinite(record.x) || !Number.isFinite(record.y)) return { observation: fail("invalid_input", "坐标必须是有限数字。"), wrote: false, cardIds: [] };
    parsed.push({ id, x: Number(record.x), y: Number(record.y) });
  }
  const byId = new Map(parsed.map((item) => [item.id, item]));
  const nodes = cloneNodes(snapshot.nodes).map((node) => byId.has(node.id) ? { ...node, position: { x: byId.get(node.id)!.x, y: byId.get(node.id)!.y }, selected: true } : { ...node, selected: false });
  ctx.host.write({ nodes, edges: cloneEdges(snapshot.edges) });
  return { observation: ok({ movedIds: parsed.map((item) => item.id) }), wrote: true, cardIds: parsed.map((item) => item.id) };
}

function arrangeCards(input: unknown, ctx: ToolRunContext, snapshot: ReturnType<CanvasToolHost["read"]>) {
  if (!input || typeof input !== "object") return { observation: fail("invalid_input", "排列参数无效。"), wrote: false, cardIds: [] };
  const record = input as Record<string, unknown>;
  if (!["horizontal", "vertical", "grid"].includes(String(record.direction))) return { observation: fail("invalid_input", "direction 只能是 horizontal、vertical 或 grid。"), wrote: false, cardIds: [] };
  const ids = idsOf(record, "cardIds", ctx, snapshot.nodes, 40);
  if (!Array.isArray(ids)) return { observation: ids, wrote: false, cardIds: [] };
  const columnsOption = record.columns === undefined ? undefined : Number(record.columns);
  if (columnsOption !== undefined && (!Number.isInteger(columnsOption) || columnsOption < 1 || columnsOption > 8)) {
    return { observation: fail("invalid_input", "columns 需要是 1 到 8 的整数。"), wrote: false, cardIds: [] };
  }
  const targets = ids.map((id) => snapshot.nodes.find((node) => node.id === id)!);
  const x = Math.min(...targets.map((node) => node.position.x));
  const y = Math.min(...targets.map((node) => node.position.y));
  const width = Math.max(...targets.map((node) => Number(node.style?.width) || sizes[node.data.kind].width)) + 48;
  const height = Math.max(...targets.map((node) => Number(node.style?.height) || sizes[node.data.kind].height)) + 56;
  const direction = String(record.direction);
  const columns = columnsOption || (direction === "horizontal" ? targets.length : direction === "vertical" ? 1 : Math.ceil(Math.sqrt(targets.length)));
  const positions = new Map(targets.map((node, index) => [node.id, { x: x + (index % columns) * width, y: y + Math.floor(index / columns) * height }]));
  const idSet = new Set(ids);
  const nodes = cloneNodes(snapshot.nodes).map((node) => positions.has(node.id) ? { ...node, position: positions.get(node.id)!, selected: true } : { ...node, selected: idSet.has(node.id) });
  ctx.host.write({ nodes, edges: cloneEdges(snapshot.edges) });
  return { observation: ok({ arrangedIds: ids, direction, columns }), wrote: true, cardIds: ids };
}

function duplicateCards(input: unknown, ctx: ToolRunContext, snapshot: ReturnType<CanvasToolHost["read"]>) {
  const ids = idsOf(input, "cardIds", ctx, snapshot.nodes, 12);
  if (!Array.isArray(ids)) return { observation: ids, wrote: false, cardIds: [] };
  const copies = new Map<string, string>();
  const nodes = cloneNodes(snapshot.nodes).map((node) => ({ ...node, selected: false }));
  for (const id of ids) {
    const source = nodes.find((node) => node.id === id)!;
    const copyId = ctx.host.createId();
    copies.set(id, copyId);
    nodes.push({
      ...source,
      id: copyId,
      data: { ...source.data },
      style: source.style ? { ...source.style } : undefined,
      position: { x: source.position.x + 40, y: source.position.y + 40 },
      selected: true,
    });
  }
  const edges = cloneEdges(snapshot.edges);
  for (const item of snapshot.edges) {
    const source = copies.get(item.source);
    const target = copies.get(item.target);
    if (!source && !target) continue;
    edges.push(edge(source || item.source, target || item.target, item.data?.relation === "sequence" ? "sequence" : "reference"));
  }
  ctx.host.write({ nodes, edges });
  ctx.createsThisRun += ids.length;
  syncShortIds(ctx);
  return { observation: ok({ copies: [...copies.entries()].map(([sourceId, id]) => ({ sourceId, id })) }), wrote: true, cardIds: [...copies.values()] };
}

function deleteCards(input: unknown, ctx: ToolRunContext, snapshot: ReturnType<CanvasToolHost["read"]>) {
  if (!input || typeof input !== "object" || !Array.isArray((input as Record<string, unknown>).cards)) {
    const legacy = idsOf(input, "cardIds", ctx, snapshot.nodes, 40);
    if (!Array.isArray(legacy)) return { observation: legacy, wrote: false, cardIds: [] };
    return { observation: fail("stale_base_hash", "删除必须带 read_cards 返回的 baseHash。这一步没有写入。"), wrote: false, cardIds: [] };
  }
  const cards = (input as { cards: unknown[] }).cards;
  if (!cards.length || cards.length > 40) return { observation: fail("invalid_input", "一次最多删除 40 张卡片。"), wrote: false, cardIds: [] };
  const ids: string[] = [];
  for (const item of cards) {
    if (!item || typeof item !== "object") return { observation: fail("invalid_input", "删除项格式无效。"), wrote: false, cardIds: [] };
    const record = item as Record<string, unknown>;
    const id = lookupId(record.cardId, ctx, snapshot.nodes);
    if (typeof id !== "string") return { observation: id, wrote: false, cardIds: [] };
    const node = snapshot.nodes.find((candidate) => candidate.id === id)!;
    if (!hashesMatch(node, record.baseHash)) return { observation: fail("stale_base_hash", "卡片内容已变化，请重新 read_cards。这一步没有删除。"), wrote: false, cardIds: [] };
    ids.push(id);
  }
  const removed = new Set(ids);
  ctx.host.write({
    nodes: cloneNodes(snapshot.nodes).filter((node) => !removed.has(node.id)),
    edges: cloneEdges(snapshot.edges).filter((item) => !removed.has(item.source) && !removed.has(item.target)),
  });
  return { observation: ok({ deletedIds: ids }), wrote: true, cardIds: ids };
}

function connectCards(input: unknown, ctx: ToolRunContext, snapshot: ReturnType<CanvasToolHost["read"]>) {
  if (!input || typeof input !== "object" || !Array.isArray((input as Record<string, unknown>).links)) {
    return { observation: fail("invalid_input", "connect_cards 需要 links。"), wrote: false, cardIds: [] };
  }
  const links = (input as { links: unknown[] }).links;
  if (!links.length || links.length > 20) return { observation: fail("invalid_input", "一次最多连接 20 条边。"), wrote: false, cardIds: [] };
  const edges = cloneEdges(snapshot.edges);
  const touched: string[] = [];
  for (const item of links) {
    if (!item || typeof item !== "object") return { observation: fail("invalid_input", "连线格式无效。"), wrote: false, cardIds: [] };
    const record = item as Record<string, unknown>;
    if (record.relation !== "reference" && record.relation !== "sequence") return { observation: fail("invalid_input", "relation 只能是 reference 或 sequence。"), wrote: false, cardIds: [] };
    const sourceId = lookupId(record.sourceId, ctx, snapshot.nodes);
    const targetId = lookupId(record.targetId, ctx, snapshot.nodes);
    if (typeof sourceId !== "string") return { observation: sourceId, wrote: false, cardIds: [] };
    if (typeof targetId !== "string") return { observation: targetId, wrote: false, cardIds: [] };
    if (sourceId === targetId) return { observation: fail("invalid_reference", "不能把卡片连到自己。"), wrote: false, cardIds: [] };
    const source = snapshot.nodes.find((node) => node.id === sourceId)!;
    const target = snapshot.nodes.find((node) => node.id === targetId)!;
    if (record.relation === "reference" && !referenceAllowed(source, target)) {
      return { observation: fail("invalid_reference", "文字只引用文字；图片可引用文字或图片，最多 5 张。视频不能作为引用。"), wrote: false, cardIds: [] };
    }
    const duplicate = edges.some((itemEdge) => itemEdge.source === sourceId && itemEdge.target === targetId && (itemEdge.data?.relation || "reference") === record.relation);
    if (duplicate) continue;
    if (record.relation === "reference") {
      const count = edges.filter((itemEdge) => itemEdge.target === targetId && itemEdge.data?.relation !== "sequence").length;
      if (count >= 5) return { observation: fail("invalid_reference", "每张卡片最多 5 条引用边。这一步没有写入。"), wrote: false, cardIds: [] };
    }
    edges.push(edge(sourceId, targetId, record.relation));
    touched.push(sourceId, targetId);
  }
  if (!touched.length) return { observation: ok({ created: 0 }), wrote: false, cardIds: [] };
  ctx.host.write({ nodes: cloneNodes(snapshot.nodes), edges });
  return { observation: ok({ linked: [...new Set(touched)] }), wrote: true, cardIds: [...new Set(touched)] };
}

function disconnectCards(input: unknown, ctx: ToolRunContext, snapshot: ReturnType<CanvasToolHost["read"]>) {
  if (!input || typeof input !== "object" || !Array.isArray((input as Record<string, unknown>).links)) {
    return { observation: fail("invalid_input", "disconnect_cards 需要 links。"), wrote: false, cardIds: [] };
  }
  const links = (input as { links: unknown[] }).links;
  if (!links.length || links.length > 20) return { observation: fail("invalid_input", "一次最多断开 20 条边。"), wrote: false, cardIds: [] };
  const remove = new Set<string>();
  const touched: string[] = [];
  for (const item of links) {
    if (!item || typeof item !== "object") return { observation: fail("invalid_input", "断线格式无效。"), wrote: false, cardIds: [] };
    const record = item as Record<string, unknown>;
    const sourceId = lookupId(record.sourceId, ctx, snapshot.nodes);
    const targetId = lookupId(record.targetId, ctx, snapshot.nodes);
    if (typeof sourceId !== "string") return { observation: sourceId, wrote: false, cardIds: [] };
    if (typeof targetId !== "string") return { observation: targetId, wrote: false, cardIds: [] };
    for (const itemEdge of snapshot.edges) {
      if (itemEdge.source !== sourceId || itemEdge.target !== targetId) continue;
      if (record.relation && itemEdge.data?.relation !== record.relation) continue;
      remove.add(itemEdge.id);
      touched.push(sourceId, targetId);
    }
  }
  if (!remove.size) return { observation: ok({ removed: 0 }), wrote: false, cardIds: [] };
  ctx.host.write({ nodes: cloneNodes(snapshot.nodes), edges: cloneEdges(snapshot.edges).filter((item) => !remove.has(item.id)) });
  return { observation: ok({ removed: remove.size }), wrote: true, cardIds: [...new Set(touched)] };
}

function proposeGeneration(input: unknown, ctx: ToolRunContext, snapshot: ReturnType<CanvasToolHost["read"]>) {
  if (!input || typeof input !== "object") return { observation: fail("invalid_input", "生成提案参数无效。"), wrote: false, cardIds: [] };
  const record = input as Record<string, unknown>;
  if (record.kind !== "image" && record.kind !== "video") return { observation: fail("invalid_input", "kind 只能是 image 或 video。"), wrote: false, cardIds: [] };
  const id = lookupId(record.targetId, ctx, snapshot.nodes);
  if (typeof id !== "string") return { observation: id, wrote: false, cardIds: [] };
  const node = snapshot.nodes.find((candidate) => candidate.id === id)!;
  if (!hashesMatch(node, record.baseHash)) return { observation: fail("stale_base_hash", "卡片内容已变化，请重新 read_cards。没有写入生成提案。"), wrote: false, cardIds: [] };
  if (typeof record.prompt !== "string" || !record.prompt.trim() || record.prompt.length > 3000) {
    return { observation: fail("invalid_input", "prompt 需要 1 到 3000 字。"), wrote: false, cardIds: [] };
  }
  if (record.aspectRatio !== undefined && !ASPECT_RATIOS.includes(record.aspectRatio as typeof ASPECT_RATIOS[number])) {
    return { observation: fail("invalid_input", "比例只能使用控制台已支持的 adaptive、1:1、16:9、9:16、4:3、3:4。"), wrote: false, cardIds: [] };
  }
  if (record.kind === "image" && record.resolution !== undefined && record.resolution !== "1K" && record.resolution !== "2K") {
    return { observation: fail("invalid_input", "图片分辨率只能是 1K 或 2K。"), wrote: false, cardIds: [] };
  }
  if (record.kind === "video" && record.duration !== undefined && record.duration !== 5 && record.duration !== 10) {
    return { observation: fail("invalid_input", "视频时长只能是 5 或 10 秒。"), wrote: false, cardIds: [] };
  }
  const referenceIds = Array.isArray(record.referenceIds) ? idsOf({ cardIds: record.referenceIds }, "cardIds", ctx, snapshot.nodes, 5) : [];
  if (!Array.isArray(referenceIds)) return { observation: referenceIds, wrote: false, cardIds: [] };
  const proposal: PendingGeneration = {
    kind: record.kind,
    prompt: record.prompt.slice(0, 3000),
    referenceIds: referenceIds.length ? referenceIds : undefined,
    aspectRatio: typeof record.aspectRatio === "string" ? record.aspectRatio : undefined,
    resolution: record.kind === "image" && (record.resolution === "1K" || record.resolution === "2K") ? record.resolution : undefined,
    duration: record.kind === "video" && (record.duration === 5 || record.duration === 10) ? record.duration : undefined,
    proposedAt: new Date().toISOString(),
  };
  const nodes = cloneNodes(snapshot.nodes).map((candidate) => candidate.id === id ? { ...candidate, data: { ...candidate.data, pendingGeneration: proposal }, selected: true } : { ...candidate, selected: false });
  ctx.host.write({ nodes, edges: cloneEdges(snapshot.edges) });
  return {
    observation: ok({
      targetId: id,
      pendingGeneration: proposal,
      executed: false,
      message: "尚未生成。P0 只记录提案，没有调用图片或视频接口。",
    }),
    wrote: true,
    cardIds: [id],
  };
}

export function previewToolCall(name: string, input: unknown) {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const ids = [
    ...(Array.isArray(record.cardIds) ? record.cardIds : []),
    ...(Array.isArray(record.cards) ? record.cards.map((item) => item && typeof item === "object" ? (item as Record<string, unknown>).cardId : "") : []),
    ...(Array.isArray(record.updates) ? record.updates.map((item) => item && typeof item === "object" ? (item as Record<string, unknown>).cardId : "") : []),
    ...(typeof record.targetId === "string" ? [record.targetId] : []),
  ].filter((id): id is string => typeof id === "string" && !!id);
  if (name === "delete_cards") return `删除 ${ids.length} 张卡片：${ids.join("、") || "未指定"}`;
  if (name === "create_cards") return `新建 ${createCountOf(input)} 张${record.cardType === "image" ? "图片" : record.cardType === "video" ? "视频" : "文字"}卡片`;
  if (name === "duplicate_cards") return `复制 ${duplicateCountOf(input)} 张卡片`;
  if (name === "propose_generation") {
    const prompt = typeof record.prompt === "string" ? record.prompt.replace(/\s+/g, " ").slice(0, 80) : "";
    return `${record.kind === "video" ? "视频" : "图片"}生成提案 · 目标 ${record.targetId || "未指定"} · ${prompt}`;
  }
  if (name === "update_text") return `修改 ${Array.isArray(record.updates) ? record.updates.length : 0} 张文字`;
  return `${name}${ids.length ? ` · ${ids.join("、")}` : ""}`;
}
