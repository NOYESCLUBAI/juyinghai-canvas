import type { ProjectLibrary } from './projectStore';
import { apiFetch } from '../lib/apiClient';

export type CloudRequest = (path: string, init?: RequestInit) => Promise<Response>;

export async function loadCloudLibrary(request: CloudRequest = apiFetch): Promise<ProjectLibrary> {
  const response = await request('/api/library');
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || data.version !== 1 || !Array.isArray(data.projects)) {
    throw new Error(typeof data?.detail === 'string' ? data.detail : '云端项目读取失败');
  }
  return data as ProjectLibrary;
}

export async function saveCloudLibrary(library: ProjectLibrary, request: CloudRequest = apiFetch): Promise<ProjectLibrary> {
  const response = await request('/api/library', {
    method: 'PUT',
    body: JSON.stringify(library),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || data.version !== 1) {
    throw new Error(typeof data?.detail === 'string' ? data.detail : '云端保存失败，操作尚未生效');
  }
  return data as ProjectLibrary;
}
