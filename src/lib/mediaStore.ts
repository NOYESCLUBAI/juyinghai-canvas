import { getAccountScope } from "../auth/accountStorage";
import { cloudActive } from "./hosted";
import { cloudAddGlobalAsset, cloudDeleteMedia, cloudListGlobalAssetIds, cloudListGlobalAssets, cloudListProjectAssets, cloudReadMedia, cloudRegisterProjectAsset, cloudSaveMedia } from "./cloudMedia";
const DATABASE_NAME = 'manjinhai-canvas-media';
const LEGACY_DATABASE_NAME = 'manlinghai-canvas-media';
export type MediaRecord = { id: string; blob: Blob; fileName: string };
export type ProjectAsset = { projectId: string; assetId: string; kind: 'image' | 'video'; fileName: string; createdAt: string };
export const ASSETS_CHANGED = 'mjh-assets-changed';
function changed() { window.dispatchEvent(new Event(ASSETS_CHANGED)); }
function activeDatabaseName() { const id = getAccountScope(); return id ? `${DATABASE_NAME}-${id}` : DATABASE_NAME; }
function openDatabase(name = activeDatabaseName()) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let blocked = false;
    const request = indexedDB.open(name, name !== LEGACY_DATABASE_NAME ? 2 : 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('media')) db.createObjectStore('media', { keyPath: 'id' });
      if (name !== LEGACY_DATABASE_NAME) {
        if (!db.objectStoreNames.contains('projectAssets')) {
          const store = db.createObjectStore('projectAssets', { keyPath: ['projectId', 'assetId'] });
          store.createIndex('projectId', 'projectId'); store.createIndex('assetId', 'assetId');
        }
        if (!db.objectStoreNames.contains('globalAssets')) db.createObjectStore('globalAssets', { keyPath: 'assetId' });
      }
    };
    request.onsuccess = () => { if (blocked) { request.result.close(); return; } request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => { blocked = true; reject(new Error('请关闭其他旧版画布标签页后重试。')); };
  });
}
async function transaction(stores: string[], mode: IDBTransactionMode, run: (tx: IDBTransaction) => void) {
  const db = await openDatabase();
  try { await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error || new Error('资产保存失败')); tx.onerror = () => reject(tx.error);
    run(tx);
  }); } finally { db.close(); }
}
export async function saveMedia(file: File, projectId?: string) {
  if (cloudActive()) return cloudSaveMedia(file, projectId);
  const id = crypto.randomUUID();
  await transaction(['media', 'projectAssets'], 'readwrite', tx => {
    tx.objectStore('media').put({ id, blob: file, fileName: file.name } satisfies MediaRecord);
    if (projectId) tx.objectStore('projectAssets').put({ projectId, assetId: id, kind: file.type.startsWith('video/') ? 'video' : 'image', fileName: file.name, createdAt: new Date().toISOString() } satisfies ProjectAsset);
  });
  changed(); return id;
}
export async function deleteMedia(id: string) {
  if (cloudActive()) { await cloudDeleteMedia(id); return; }
  // History and manually saved assets own their media independently of canvas nodes.
  await transaction(['media', 'projectAssets', 'globalAssets'], 'readwrite', tx => {
    const history = tx.objectStore('projectAssets').index('assetId').count(id);
    history.onsuccess = () => {
      if (history.result) return;
      const saved = tx.objectStore('globalAssets').get(id);
      saved.onsuccess = () => { if (!saved.result) tx.objectStore('media').delete(id); };
    };
  });
}
export async function readMedia(id: string): Promise<MediaRecord | undefined> {
  if (cloudActive()) return cloudReadMedia(id);
  for (const name of (getAccountScope() ? [activeDatabaseName()] : [DATABASE_NAME, LEGACY_DATABASE_NAME])) {
    const db = await openDatabase(name);
    try {
      const record = await new Promise<MediaRecord | undefined>((resolve, reject) => {
        const request = db.transaction('media').objectStore('media').get(id);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      if (record) return record;
    } finally { db.close(); }
  }
}
export async function registerProjectAsset(asset: ProjectAsset) {
  if (cloudActive()) { await cloudRegisterProjectAsset(asset); return; }
  const media = await readMedia(asset.assetId);
  if (!media) return;
  await transaction(['media', 'projectAssets'], 'readwrite', tx => {
    tx.objectStore('media').put(media);
    const store = tx.objectStore('projectAssets');
    const request = store.get([asset.projectId, asset.assetId]);
    request.onsuccess = () => { if (!request.result) store.put(asset); };
  });
}
export async function listProjectAssets(projectId: string) {
  if (cloudActive()) return cloudListProjectAssets(projectId);
  let assets: ProjectAsset[] = [];
  await transaction(['projectAssets'], 'readonly', tx => {
    const request = tx.objectStore('projectAssets').index('projectId').getAll(projectId);
    request.onsuccess = () => { assets = request.result; };
  });
  return assets.sort((a,b) => b.createdAt.localeCompare(a.createdAt));
}
export async function listGlobalAssetIds() {
  if (cloudActive()) return cloudListGlobalAssetIds();
  let ids: string[] = [];
  await transaction(['globalAssets'], 'readonly', tx => {
    const request = tx.objectStore('globalAssets').getAllKeys();
    request.onsuccess = () => { ids = request.result as string[]; };
  }); return ids;
}
export async function addGlobalAsset(asset: ProjectAsset) {
  if (cloudActive()) {
    const media = await readMedia(asset.assetId);
    if (!media) throw new Error('素材文件不可用，请重新上传。');
    await cloudAddGlobalAsset({ ...asset, savedAt: new Date().toISOString() });
    changed();
    return;
  }
  const media = await readMedia(asset.assetId);
  if (!media) throw new Error('素材文件不可用，请重新上传。');
  await transaction(['media', 'globalAssets'], 'readwrite', tx => {
    tx.objectStore('media').put(media);
    const store = tx.objectStore('globalAssets'); const request = store.get(asset.assetId);
    request.onsuccess = () => { if (!request.result) store.put({ ...asset, savedAt: new Date().toISOString() }); };
  }); changed();
}

export type GlobalAsset = ProjectAsset & { savedAt: string };
export async function listGlobalAssets() {
  if (cloudActive()) return cloudListGlobalAssets();
  let assets: GlobalAsset[] = [];
  await transaction(['globalAssets'], 'readonly', tx => {
    const request = tx.objectStore('globalAssets').getAll();
    request.onsuccess = () => { assets = request.result; };
  });
  return assets.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}
