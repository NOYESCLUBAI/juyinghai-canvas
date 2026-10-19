import { apiFetch } from '../lib/apiClient';

/**
 * Cloud sessions for the Agent P0 proxy branch.
 *
 * P0 keeps `mjh.agentSessions.v1` in localStorage for the local app. When this
 * build is hosted and the user is signed in, sessionStore should call these
 * functions instead of writing that key. The FastAPI route filters by the JWT
 * user id; do not send a user id in the body. One row per project + canvas.
 */
export type CloudAgentSession = {
  projectId: string;
  canvasId: string;
  messages: unknown[];
  updatedAt: string | null;
};

export async function loadCloudAgentSession(projectId: string, canvasId: string, request = apiFetch): Promise<CloudAgentSession> {
  const path = `/api/agent-sessions?project_id=${encodeURIComponent(projectId)}&canvas_id=${encodeURIComponent(canvasId)}`;
  const response = await request(path);
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(data?.detail || '会话读取失败');
  return data as CloudAgentSession;
}

export async function saveCloudAgentSession(session: Pick<CloudAgentSession, 'projectId' | 'canvasId' | 'messages'>, request = apiFetch) {
  const response = await request('/api/agent-sessions', { method: 'PUT', body: JSON.stringify(session) });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(data?.detail || '会话保存失败');
  return data as CloudAgentSession;
}
