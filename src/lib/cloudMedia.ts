import { apiFetch, resolveApiUrl } from './apiClient';
import type { CloudRequest } from '../projects/cloudLibrary';
import type { GlobalAsset, MediaRecord, ProjectAsset } from './mediaStore';

async function readJson(response: Response) {
  return response.json().catch(() => null);
}

export function cloudMediaApi(request: CloudRequest = apiFetch) {
  return {
    async save(file: File, projectId?: string) {
      const body = new FormData();
      body.append('file', file, file.name);
      if (projectId) body.append('project_id', projectId);
      const response = await request('/api/media', { method: 'POST', body });
      const data = await readJson(response);
      if (!response.ok || typeof data?.assetId !== 'string') {
        throw new Error(typeof data?.detail === 'string' ? data.detail : '素材上传失败');
      }
      return data.assetId as string;
    },
    async read(id: string): Promise<MediaRecord | undefined> {
      const response = await request(`/api/media/${encodeURIComponent(id)}`);
      if (response.status === 404) return undefined;
      const meta = await readJson(response);
      if (!response.ok || typeof meta?.url !== 'string') {
        throw new Error(typeof meta?.detail === 'string' ? meta.detail : '素材读取失败');
      }
      const file = await fetch(resolveApiUrl(meta.url));
      if (!file.ok) throw new Error('素材读取失败');
      return { id, blob: await file.blob(), fileName: typeof meta.fileName === 'string' ? meta.fileName : id };
    },
    async remove(id: string) {
      const response = await request(`/api/media/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!response.ok && response.status !== 404) {
        const data = await readJson(response);
        throw new Error(typeof data?.detail === 'string' ? data.detail : '素材删除失败');
      }
    },
    async register(asset: ProjectAsset) {
      const response = await request('/api/project-assets', { method: 'POST', body: JSON.stringify(asset) });
      if (!response.ok) {
        const data = await readJson(response);
        throw new Error(typeof data?.detail === 'string' ? data.detail : '素材登记失败');
      }
    },
    async listProject(projectId: string) {
      const response = await request(`/api/projects/${encodeURIComponent(projectId)}/assets`);
      const data = await readJson(response);
      if (!response.ok || !Array.isArray(data?.assets)) throw new Error(data?.detail || '素材列表读取失败');
      return data.assets as ProjectAsset[];
    },
    async listGlobal() {
      const response = await request('/api/global-assets');
      const data = await readJson(response);
      if (!response.ok || !Array.isArray(data?.assets)) throw new Error(data?.detail || '全局资产读取失败');
      return data.assets as GlobalAsset[];
    },
    async listGlobalIds() {
      const assets = await this.listGlobal();
      return assets.map(asset => asset.assetId);
    },
    async addGlobal(asset: GlobalAsset) {
      const response = await request('/api/global-assets', { method: 'POST', body: JSON.stringify(asset) });
      const data = await readJson(response);
      if (!response.ok) throw new Error(typeof data?.detail === 'string' ? data.detail : '加入全局资产失败');
    },
  };
}

const cloud = () => cloudMediaApi();

export const cloudSaveMedia = (file: File, projectId?: string) => cloud().save(file, projectId);
export const cloudReadMedia = (id: string) => cloud().read(id);
export const cloudDeleteMedia = (id: string) => cloud().remove(id);
export const cloudRegisterProjectAsset = (asset: ProjectAsset) => cloud().register(asset);
export const cloudListProjectAssets = (projectId: string) => cloud().listProject(projectId);
export const cloudListGlobalAssets = () => cloud().listGlobal();
export const cloudListGlobalAssetIds = () => cloud().listGlobalIds();
export const cloudAddGlobalAsset = (asset: GlobalAsset) => cloud().addGlobal(asset);
