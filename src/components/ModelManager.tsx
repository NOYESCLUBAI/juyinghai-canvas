import { Check, Clapperboard, FileText, Image as ImageIcon, Plus, RefreshCw, ShieldCheck, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { isHostedMode } from "../lib/hosted";
import { configApi, configValue, type ConfigDraft, type ModelCatalog, type ModelConfig, type ModelKind } from "../lib/modelConfigs";

export type ModelServiceStatus = "loading" | "configured" | "unconfigured" | "unavailable";
export type ManagedModelGroup = {
  id: ModelKind; title: string; description: string; provider: string;
  status: ModelServiceStatus; selectedModel: string; models: string[];
  note?: string; onModelChange: (model: string) => void;
};
type Props = {
  open: boolean; groups: ManagedModelGroup[]; onClose: () => void;
  catalog: ModelCatalog | null; connectionError: string; onRefresh: () => void;
};
const icons = { text: FileText, image: ImageIcon, video: Clapperboard };
const protocols = {
  text: [["chat", "文字 · OpenAI 兼容 / Agnes"]],
  image: [["openai-image", "图片 · OpenAI 兼容"], ["agnes-image", "图片 · Agnes"]],
  video: [["agnes-video", "视频 · Agnes"]],
};
const statusLabels = { loading: "正在读取", configured: "已配置 · 未验证", unconfigured: "未配置 Key", unavailable: "本机后端未连接" };

export function ModelManager({ open, groups, onClose, catalog, connectionError, onRefresh }: Props) {
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState<{ id?: string; draft: ConfigDraft } | null>(null);
  const [agnesOpen, setAgnesOpen] = useState(false);
  const [agnesUrl, setAgnesUrl] = useState("");
  const [agnesKey, setAgnesKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [tests, setTests] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    if (!open) { setEditing(null); setAgnesKey(""); setAgnesOpen(false); return; }
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key !== "Tab") return;
      const items = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]') || []);
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.body.style.overflow = overflow; document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, [open, onClose]);

  if (!open) return null;
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setFeedback("");
    try { await action(); } catch (error) { setFeedback(error instanceof Error ? error.message : "操作失败，请重试"); }
    finally { setBusy(false); }
  };
  const edit = (kind: ModelKind, config?: ModelConfig) => {
    setFeedback(""); setAgnesOpen(false); setDeleting(null);
    setEditing({ id: config?.id, draft: {
      name: config?.name || "", kind, protocol: config?.protocol || protocols[kind][0][0],
      base_url: config?.base_url || (kind === "video" ? "https://apihub.agnes-ai.com/v1" : ""),
      model: config?.model || "", api_key: "",
    } });
  };
  const test = (config: ModelConfig) => void run(async () => {
    const result = await configApi<{ message: string }>(`/${encodeURIComponent(config.id)}/test`, "POST", {});
    setTests(current => ({ ...current, [config.id]: result.message }));
  });
  return <div className="model-manager-layer" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <aside ref={panel} className="model-manager-panel" role="dialog" aria-modal="true" aria-labelledby="model-manager-title">
      <header className="model-manager-header">
        <div><span>工作区设置</span><h2 id="model-manager-title">模型管理</h2><p>选择内置模型，或连接你自己的模型服务。</p></div>
        <button ref={closeButton} onClick={onClose} aria-label="关闭模型管理"><X size={18}/></button>
      </header>
      <div className="model-manager-summary">
        <div><span>模型服务</span><strong>{groups.filter(g => g.status === "configured").length} / 3 已配置</strong></div>
        <p>切换用于新的生成任务；配置保存在本机，模型选择保存在当前浏览器。</p>
        <div className="model-config-actions">
          <button disabled={busy} onClick={() => { setEditing(null); setAgnesOpen(!agnesOpen); setAgnesUrl(catalog?.agnes.base_url || "https://apihub.agnes-ai.com/v1"); setAgnesKey(""); }}>设置 Agnes 连接</button>
          <button disabled={busy} onClick={onRefresh}><RefreshCw size={13}/>重新连接</button>
        </div>
      </div>
      <div className="model-manager-groups">
        {connectionError && <div className="model-config-alert" role="alert">{connectionError}<br/>在项目目录使用 npm run dev 同时启动前后端。</div>}
        {feedback && <p className="model-config-alert" role="status">{feedback}</p>}
        {agnesOpen && <form className="model-config-form" onSubmit={event => { event.preventDefault(); void run(async () => {
          await configApi('/agnes', 'PUT', { base_url: agnesUrl, api_key: agnesKey });
          setAgnesKey(""); setAgnesOpen(false); setTests({}); setFeedback("Agnes 连接已保存，生成时验证。"); onRefresh();
        }); }}>
          <h3>Agnes 共用连接</h3><p>三个分类中的 Agnes 内置模型共用此连接；请填写与 Key 对应的站点地址。</p>
          <label>API 地址<input required type="url" value={agnesUrl} onChange={e => setAgnesUrl(e.target.value)} placeholder="https://apihub.agnes-ai.com/v1"/></label>
          <label>API Key<input type="password" autoComplete="new-password" required={!catalog?.agnes.configured} value={agnesKey} onChange={e => setAgnesKey(e.target.value)} placeholder={catalog?.agnes.configured ? "已保存，留空保留原 Key" : "输入自己的 Agnes Key"}/></label>
          <div className="model-config-actions"><button disabled={busy || !!connectionError} type="submit">保存连接</button><button type="button" onClick={() => { setAgnesOpen(false); setAgnesKey(""); }}>取消</button></div>
        </form>}
        {groups.map(group => {
          const Icon = icons[group.id];
          const configs = catalog?.configs.filter(c => c.kind === group.id) || [];
          const current = configs.find(c => configValue(c) === group.selectedModel);
          return <section className="model-manager-group" key={group.id}>
            <div className="model-manager-group-header">
              <div className="model-manager-kind"><Icon size={18}/></div>
              <div className="model-manager-group-title"><h3>{group.title}</h3><p>{group.description}</p></div>
              <span className="model-manager-status">{group.status === "unavailable" ? statusLabels.unavailable : !current ? "请选择模型" : current.configured ? statusLabels.configured : statusLabels.unconfigured}</span>
            </div>
            {([true, false] as const).map(builtin => <div key={String(builtin)} className="model-config-section">
              <div className="model-config-section-heading"><h4>{builtin ? "内置模型" : "自定义模型"}</h4>{!builtin && <button disabled={busy || !!connectionError} onClick={() => edit(group.id)}><Plus size={13}/>添加{group.title}</button>}</div>
              {!builtin && !configs.some(c => !c.builtin) && <p className="model-config-hint">添加接口地址、Key 和模型 ID，即可使用自己的模型。</p>}
              {configs.filter(c => c.builtin === builtin).map(config => <div className={`model-config-row ${configValue(config) === group.selectedModel ? "is-selected" : ""}`} key={config.id}>
                <button className="model-config-select" disabled={busy || !!connectionError} onClick={() => group.onModelChange(configValue(config))} aria-pressed={configValue(config) === group.selectedModel}>
                  <span><strong>{config.name}</strong>{!builtin && <small>{config.model}</small>}<small>{config.pricing || (config.configured ? "已配置 Key" : "未配置 Key")}</small></span>
                  {configValue(config) === group.selectedModel ? <span className="model-config-current"><Check size={14}/>当前使用</span> : <span className="model-config-current">选择</span>}
                </button>
                <div className="model-config-actions">
                  <button disabled={busy || !!connectionError || !config.configured} onClick={() => test(config)}>测试连接</button>
                  {!builtin && <><button disabled={busy} onClick={() => edit(group.id, config)}>编辑</button><button disabled={busy} onClick={() => setDeleting(config.id)}>删除</button></>}
                </div>
                {tests[config.id] && <p className="model-config-hint" role="status">{tests[config.id]}</p>}
                {deleting === config.id && <div className="model-config-delete"><p>删除“{config.name}”？{configValue(config) === group.selectedModel && "删除后需要重新选择模型。"}</p><button disabled={busy} onClick={() => void run(async () => {
                  await configApi(`/${encodeURIComponent(config.id)}`, 'DELETE');
                  if (group.selectedModel === configValue(config)) group.onModelChange("");
                  setDeleting(null); onRefresh();
                })}>确认删除</button><button onClick={() => setDeleting(null)}>取消</button></div>}
              </div>)}
            </div>)}
            {editing?.draft.kind === group.id && <form className="model-config-form" onSubmit={event => { event.preventDefault(); void run(async () => {
              await configApi(editing.id ? `/${encodeURIComponent(editing.id)}` : '', editing.id ? 'PUT' : 'POST', editing.draft);
              setEditing(null); setTests({}); setFeedback("配置已保存，可选择模型并测试连接。"); onRefresh();
            }); }}>
              <h3>{editing.id ? "编辑" : "添加"}{group.title}</h3>
              <label>配置名称<input required maxLength={100} value={editing.draft.name} onChange={e => setEditing({ ...editing, draft: { ...editing.draft, name: e.target.value } })} placeholder="例如：我的文字模型"/></label>
              <label>接口类型<select value={editing.draft.protocol} onChange={e => setEditing({ ...editing, draft: { ...editing.draft, protocol: e.target.value } })}>{protocols[group.id].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label>API 地址<input required type="url" value={editing.draft.base_url} onChange={e => setEditing({ ...editing, draft: { ...editing.draft, base_url: e.target.value } })} placeholder="https://你的服务地址/v1"/></label>
              <label>API Key<input required={!editing.id} type="password" autoComplete="new-password" value={editing.draft.api_key} onChange={e => setEditing({ ...editing, draft: { ...editing.draft, api_key: e.target.value } })} placeholder={editing.id ? "留空保留原 Key" : "输入自己的密钥"}/></label>
              <label>模型 ID<input required maxLength={120} value={editing.draft.model} onChange={e => setEditing({ ...editing, draft: { ...editing.draft, model: e.target.value } })} placeholder="填写服务商提供的完整模型 ID"/></label>
              {group.id === "video" && <p>目前支持 Agnes 视频协议，其他视频平台后续增加。</p>}
              <div className="model-config-actions"><button type="submit" disabled={busy || !!connectionError}>保存配置</button><button type="button" onClick={() => setEditing(null)}>取消</button></div>
            </form>}
          </section>;
        })}
        <p className="model-config-hint">免费状态以平台账单为准。<a href="https://www.agnes-ai.com/zh-Hans/docs/pricing" target="_blank" rel="noreferrer">查看 Agnes 官方定价</a></p>
      </div>
      <footer className="model-manager-footer"><ShieldCheck size={15}/><span>{isHostedMode() ? 'Key 加密后只保存在你的账号下，列表和导出文件都不会带出密钥。测试连接不会创建生成任务。' : 'Key 仅保存在本机后端，不随画布导出。测试连接不会创建生成任务。'}</span></footer>
    </aside>
  </div>;
}
