import type { ModelMessage } from "ai";
import type { CanvasAgentPlan } from "./canvasAgent";
import { HISTORY_LIMIT, TOOL_RESULT_CHARS } from "./constants";

export const AGENT_SESSION_KEY = "mjh.agentSessions.v1";

export type AgentStep = {
  id: string;
  tool: string;
  status: "running" | "done" | "error" | "approval";
  text: string;
};

export type AgentUiMessage = {
  id: string;
  role: "assistant" | "user";
  text: string;
  steps?: AgentStep[];
  mode?: "ai" | "demo";
  notice?: string;
  confirmation?: boolean;
  plan?: CanvasAgentPlan;
  undoable?: boolean;
  approval?: { approvalId: string; tool: string; preview: string; pending: boolean };
};

export type AgentSession = {
  projectId: string;
  canvasId: string;
  updatedAt: string;
  messages: AgentUiMessage[];
  modelMessages: ModelMessage[];
};

type SessionFile = { version: 1; sessions: AgentSession[] };
type StorageAccess = Pick<Storage, "getItem" | "setItem">;

const dataUri = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi;

export function truncateStoredText(value: string, limit = TOOL_RESULT_CHARS) {
  const stripped = value.replace(dataUri, "[data-uri]");
  return stripped.length > limit ? `${stripped.slice(0, limit)}…` : stripped;
}

function emptyFile(): SessionFile {
  return { version: 1, sessions: [] };
}

function readFile(storage: StorageAccess): SessionFile {
  const raw = storage.getItem(AGENT_SESSION_KEY);
  if (!raw) return emptyFile();
  const parsed = JSON.parse(raw) as SessionFile;
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.sessions)) return emptyFile();
  return parsed;
}

export function trimModelMessages(messages: ModelMessage[], limit = HISTORY_LIMIT): ModelMessage[] {
  const next = messages.slice(-limit).map(truncateModelMessage);
  while (next.length && next[0]?.role === "tool") next.shift();
  return next;
}

function shrinkValue(value: unknown): unknown {
  if (typeof value === "string") return truncateStoredText(value);
  if (Array.isArray(value)) return value.map((item) => shrinkValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shrinkValue(item)]));
  }
  return value;
}

function truncateModelMessage(message: ModelMessage): ModelMessage {
  return shrinkValue(message) as ModelMessage;
}

export function loadAgentSession(storage: StorageAccess, projectId: string, canvasId: string) {
  try {
    const file = readFile(storage);
    return file.sessions.find((session) => session.projectId === projectId && session.canvasId === canvasId) || null;
  } catch {
    return null;
  }
}

export function saveAgentSession(storage: StorageAccess, session: AgentSession): { ok: true } | { ok: false; message: string } {
  try {
    const file = readFile(storage);
    const next: AgentSession = {
      ...session,
      updatedAt: new Date().toISOString(),
      messages: session.messages.slice(-HISTORY_LIMIT).map((message) => ({
        ...message,
        text: truncateStoredText(message.text, 4000),
      })),
      modelMessages: trimModelMessages(session.modelMessages),
    };
    const sessions = [
      next,
      ...file.sessions.filter((item) => item.projectId !== session.projectId || item.canvasId !== session.canvasId),
    ];
    storage.setItem(AGENT_SESSION_KEY, JSON.stringify({ version: 1, sessions }));
    const written = storage.getItem(AGENT_SESSION_KEY) || "";
    if (!written.includes(session.canvasId) || /data:(?:image|video)/.test(written)) return { ok: false, message: "对话未能保存" };
    return { ok: true };
  } catch {
    return { ok: false, message: "对话未能保存" };
  }
}
