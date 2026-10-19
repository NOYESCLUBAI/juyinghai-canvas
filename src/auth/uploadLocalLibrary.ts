import { cleanProject, LIBRARY_KEY, type ProjectEntry, type ProjectLibrary } from '../projects/projectStore';
import { loadCloudLibrary, saveCloudLibrary } from '../projects/cloudLibrary';
import { deleteMedia, saveMedia, registerProjectAsset, type MediaRecord } from '../lib/mediaStore';

const markerKey = (userId: string) => `mjh.account.${userId}.cloud-import-v1`;

function assetIdFor(map: Map<string, string>, current: string | undefined, assign: (oldId: string) => string) {
  if (!current) return current;
  if (!map.has(current)) map.set(current, assign(current));
  return map.get(current);
}

/** New project ids and new asset ids. The caller's library object is not modified. */
export function copyProjectsForCloud(library: ProjectLibrary, newProjectId: () => string, newAssetId: (oldId: string) => string) {
  const assetMap = new Map<string, string>();
  const projects = library.projects.filter(entry => !entry.trashedAt).map(source => {
    const project = cleanProject(structuredClone(source.project));
    const entry: ProjectEntry = {
      ...structuredClone(source),
      id: newProjectId(),
      project,
      trashedAt: undefined,
      lastOpenedAt: undefined,
    };
    entry.coverAssetId = assetIdFor(assetMap, entry.coverAssetId, newAssetId);
    for (const canvas of entry.project.canvases) {
      for (const node of canvas.nodes) {
        if (node.data.assetId) node.data.assetId = assetIdFor(assetMap, node.data.assetId, newAssetId);
      }
    }
    return entry;
  });
  return { projects, assetMap };
}

function openDatabase(name: string) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readUnscoped(id: string): Promise<MediaRecord | undefined> {
  for (const name of ['manjinhai-canvas-media', 'manlinghai-canvas-media']) {
    const db = await openDatabase(name);
    try {
      if (!db.objectStoreNames.contains('media')) continue;
      const record = await new Promise<MediaRecord | undefined>((resolve, reject) => {
        const request = db.transaction('media').objectStore('media').get(id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      if (record) return record;
    } finally {
      db.close();
    }
  }
}

/**
 * Upload the browser's unscoped local library as new cloud copies.
 * `local-imported` is intentionally not used: that flag only means a local account copy.
 */
export async function uploadLocalLibrary(userId: string) {
  const raw = localStorage.getItem(LIBRARY_KEY);
  if (!raw) throw new Error('没有可导入的本机项目');
  const source = JSON.parse(raw) as ProjectLibrary;
  if (source.version !== 1 || !Array.isArray(source.projects)) throw new Error('本机项目格式无法读取');
  let done: string[] = [];
  try { done = JSON.parse(localStorage.getItem(markerKey(userId)) || '[]'); } catch { done = []; }
  const finished = new Set(done);
  const pending = source.projects.filter(entry => !entry.trashedAt && !finished.has(entry.id));
  if (!pending.length) throw new Error('本机内容已上传到云端');
  const cloud = await loadCloudLibrary();
  for (const sourceEntry of pending) {
    const planned = new Map<string, string>();
    const { projects } = copyProjectsForCloud({ version: 1, projects: [sourceEntry] }, () => crypto.randomUUID(), oldId => {
      const id = crypto.randomUUID();
      planned.set(oldId, id);
      return id;
    });
    const copy = projects[0];
    const uploaded: string[] = [];
    let stored = false;
    try {
      for (const [oldId, assetId] of planned) {
        const record = await readUnscoped(oldId);
        if (!record) throw new Error('有素材无法从本机读取，该项目尚未上传');
        const file = new File([record.blob], record.fileName || 'asset', { type: record.blob.type || 'application/octet-stream' });
        const storedId = await saveMedia(file);
        if (storedId !== assetId) {
          const replace = (value?: string) => value === assetId ? storedId : value;
          copy.coverAssetId = replace(copy.coverAssetId);
          for (const canvas of copy.project.canvases) {
            for (const node of canvas.nodes) node.data.assetId = replace(node.data.assetId);
          }
        }
        uploaded.push(storedId);
      }
      cloud.projects = [...cloud.projects, copy];
      const saved = await saveCloudLibrary(cloud);
      cloud.projects = saved.projects;
      stored = true;
      finished.add(sourceEntry.id);
      localStorage.setItem(markerKey(userId), JSON.stringify([...finished]));
      for (const assetId of uploaded) {
        const name = copy.project.canvases.flatMap(canvas => canvas.nodes).find(node => node.data.assetId === assetId)?.data.fileName || 'asset';
        const kind = copy.project.canvases.flatMap(canvas => canvas.nodes).some(node => node.data.assetId === assetId && node.data.kind === 'video') ? 'video' : 'image';
        await registerProjectAsset({ projectId: copy.id, assetId, kind, fileName: name, createdAt: copy.createdAt });
      }
    } catch (error) {
      if (stored) throw error instanceof Error ? error : new Error('项目已上传，但部分素材登记失败。请重新打开项目。');
      cloud.projects = cloud.projects.filter(entry => entry.id !== copy.id);
      await Promise.allSettled(uploaded.map(id => deleteMedia(id)));
      throw error instanceof Error ? error : new Error('上传中断，未完成的项目没有写入云端');
    }
  }
}
