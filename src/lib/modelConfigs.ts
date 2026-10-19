import { accountStorage } from "../auth/accountStorage";
import { apiFetch } from "./apiClient";
export type ModelKind = "text" | "image" | "video";
export type ModelConfig = {
  id: string; name: string; kind: ModelKind; protocol: string; base_url: string;
  model: string; builtin: boolean; pricing: string; configured: boolean;
};
export type ModelCatalog = {
  configs: ModelConfig[];
  agnes: { base_url: string; configured: boolean };
  defaults: Record<ModelKind, string>;
};
export type ConfigDraft = Pick<ModelConfig, "name" | "kind" | "protocol" | "base_url" | "model"> & { api_key: string };
let catalog: ModelCatalog | null = null;
let selections: Partial<Record<ModelKind, string>> = {};
const STORAGE = "mjh.model-selections.v2";

export async function configApi<T>(path = "", method = "GET", body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await apiFetch(`/api/model-configs${path}`, {
      method, headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch { throw new Error("本机后端未连接或响应超时，请检查启动终端后重试"); }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(typeof data?.detail === "string" ? data.detail : "本机后端未连接，请检查启动终端后重试");
  return data as T;
}
export function configValue(config: ModelConfig) { return config.builtin ? config.model : config.id; }
export function modelLabel(value: string) {
  const config = catalog?.configs.find(c => configValue(c) === value);
  return config ? (config.builtin ? config.model : `${config.name} · ${config.model}`) : (value.startsWith("custom:") ? "配置已删除，请重新选择" : value || "请选择模型");
}
export function selectedConfig(kind: ModelKind, value = selections[kind]) {
  return catalog?.configs.find(c => c.kind === kind && configValue(c) === value);
}
export function saveModelSelection(kind: ModelKind, value: string) {
  selections = { ...selections, [kind]: value };
  accountStorage.setItem(STORAGE, JSON.stringify(selections));
}
export function modelRequest(kind: ModelKind, value = selections[kind]) {
  if (value === "") throw new Error("请先在模型管理中选择模型");
  const config = selectedConfig(kind, value);
  if (config) return { model_config_id: config.id, model: config.model };
  if (value?.startsWith("custom:")) throw new Error("模型配置已删除，请重新选择");
  return value ? { model: value } : {};
}
export async function loadModelCatalog(legacy: Record<ModelKind, string | null>) {
  const next = await configApi<ModelCatalog>();
  catalog = next;
  let stored: Partial<Record<ModelKind, string>> = {};
  try { stored = JSON.parse(accountStorage.getItem(STORAGE) || "{}"); } catch { /* migrate legacy */ }
  for (const kind of ["text", "image", "video"] as const) {
    const candidate = stored[kind] ?? legacy[kind] ?? next.defaults[kind];
    selections[kind] = next.configs.some(c => c.kind === kind && configValue(c) === candidate) ? candidate : "";
  }
  accountStorage.setItem(STORAGE, JSON.stringify(selections));
  return { catalog: next, selections: { ...selections } as Record<ModelKind, string> };
}
