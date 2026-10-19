import { cleanProject, type ProjectEntry } from './projectStore';
import { listProjectAssets, readMedia, saveMedia, registerProjectAsset, deleteMedia } from '../lib/mediaStore';

export const BACKUP_LIMIT = 100 * 1024 * 1024;
type BackupMedia = { id: string; name: string; type: string; base64: string };
type Backup = { format: 'manjinhai-project'; version: 1; entry: ProjectEntry; media: BackupMedia[] };
const fail = () => { throw new Error('备份格式不正确或内容不完整，请使用漫金海导出的项目备份。'); };
export function parseBackup(text: string): Backup {
  const b = JSON.parse(text);
  const str = (v: unknown) => typeof v === 'string' && v.length > 0;
  const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  if (!b || b.format !== 'manjinhai-project' || b.version !== 1 || !Array.isArray(b.media)) fail();
  const e = b.entry, p = e?.project;
  if (!str(e?.id) || !p || p.version !== 2 || !str(p.projectTitle) || !Array.isArray(p.canvases) || !p.canvases.length) fail();
  const mediaIds = new Set<string>();
  for (const m of b.media) {
    if (!str(m.id) || mediaIds.has(m.id) || typeof m.name !== 'string' || !/^(image\/(png|jpeg|webp|gif|avif)|video\/(mp4|webm|quicktime))$/.test(m.type) || typeof m.base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(m.base64)) fail();
    mediaIds.add(m.id);
  }
  const canvasIds = new Set<string>();
  for (const c of p.canvases) {
    if (!str(c.id) || canvasIds.has(c.id) || typeof c.title !== 'string' || !Array.isArray(c.nodes) || !Array.isArray(c.edges) || !finite(c.viewport?.x) || !finite(c.viewport?.y) || !finite(c.viewport?.zoom) || c.viewport.zoom <= 0) fail();
    canvasIds.add(c.id);
    const ids = new Set<string>();
    for (const n of c.nodes) {
      if (!str(n.id) || ids.has(n.id) || n.type !== 'canvas-card' || !finite(n.position?.x) || !finite(n.position?.y) || !['text','image','video'].includes(n.data?.kind)) fail();
      if (n.data.text !== undefined && typeof n.data.text !== 'string') fail();
      if (n.data.assetId !== undefined && !mediaIds.has(n.data.assetId)) fail();
      if (n.data.imageGeneration && !Array.isArray(n.data.imageGeneration.referenceIds)) fail();
      ids.add(n.id);
    }
    for (const edge of c.edges) if (!str(edge.id) || !ids.has(edge.source) || !ids.has(edge.target)) fail();
  }
  if (!canvasIds.has(p.activeCanvasId) || (e.coverAssetId && !mediaIds.has(e.coverAssetId))) fail();
  return b;
}
export async function createProjectBackup(entry: ProjectEntry) {
  const history = await listProjectAssets(entry.id);
  const ids = new Set([...history.map(a => a.assetId), ...entry.project.canvases.flatMap(c => c.nodes.flatMap(n => n.data.assetId ? [n.data.assetId] : [])), ...(entry.coverAssetId ? [entry.coverAssetId] : [])]);
  const media: BackupMedia[] = [];
  let size = 0;
  for (const id of ids) {
    const record = await readMedia(id);
    if (!record) throw new Error('项目中有素材丢失，无法生成完整备份，请先检查素材。');
    size += Math.ceil(record.blob.size / 3) * 4;
    if (size > BACKUP_LIMIT) throw new Error('备份超过 100 MB，当前版本请先单独下载大型视频。');
    const data = await new Promise<string>((resolve,reject) => { const reader = new FileReader(); reader.onload=()=>resolve(String(reader.result).split(',')[1]); reader.onerror=()=>reject(reader.error); reader.readAsDataURL(record.blob); });
    media.push({id,name:record.fileName,type:record.blob.type,base64:data});
  }
  const backup: Backup = {format:'manjinhai-project',version:1,entry:{...entry,project:cleanProject(entry.project)},media};
  const text = JSON.stringify(backup);
  parseBackup(text);
  const blob = new Blob([text],{type:'application/json'});
  if (blob.size > BACKUP_LIMIT) throw new Error('备份超过 100 MB，当前版本请先单独下载大型视频。');
  return blob;
}
export async function exportProject(entry: ProjectEntry) {
  const blob = await createProjectBackup(entry);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download=`${entry.project.projectTitle.replace(/[\\/:*?"<>|]/g,'_')}.mjh.json`; a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export async function importProject(file: File, commit: (entry: ProjectEntry) => void, limit = BACKUP_LIMIT) {
  if (file.size > limit) throw new Error(limit === BACKUP_LIMIT ? '当前支持不超过 100 MB 的项目备份。' : '备份文件过大。云端导入请把单个备份控制在 512 MB 以内，素材会逐个上传。');
  const backup = parseBackup(await file.text());
  const ids = new Map<string,string>();
  let committed = false;
  try {
    for (const m of backup.media) {
      const bytes = Uint8Array.from(atob(m.base64), c => c.charCodeAt(0));
      ids.set(m.id, await saveMedia(new File([bytes],m.name,{type:m.type})));
    }
    const entry = structuredClone(backup.entry);
    entry.id=crypto.randomUUID(); entry.project=cleanProject(entry.project);
    entry.project.projectTitle += '（导入）'; entry.trashedAt=undefined; entry.lastOpenedAt=undefined;
    entry.createdAt=entry.updatedAt=new Date().toISOString(); entry.favorite=!!entry.favorite;
    if(entry.coverAssetId) entry.coverAssetId=ids.get(entry.coverAssetId);
    for (const c of entry.project.canvases) for (const n of c.nodes) if(n.data.assetId) n.data.assetId=ids.get(n.data.assetId);
    // Publish only after every media file is durable; never overwrite existing projects or media.
    commit(entry); committed=true;
    for (const m of backup.media) await registerProjectAsset({projectId:entry.id,assetId:ids.get(m.id)!,fileName:m.name,kind:m.type.startsWith('video/')?'video':'image',createdAt:entry.createdAt});
  } catch(error) {
    if(!committed) await Promise.allSettled([...ids.values()].map(deleteMedia));
    if(committed) throw new Error('项目已导入，但部分历史资产登记失败；画布素材已保留，请重新打开项目。');
    throw error;
  }
}
