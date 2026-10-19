import { supabase } from '../auth/client';
import { apiBase, isHostedMode } from './hosted';

export function resolveApiUrl(url: string) {
  if (/^https?:\/\//i.test(url)) return url;
  return `${apiBase()}${url}`;
}

async function accessToken() {
  const session = await supabase?.auth.getSession();
  return session?.data.session?.access_token || '';
}

export async function apiFetch(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (isHostedMode() && !headers.has('Authorization')) {
    const token = await accessToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(resolveApiUrl(path), { ...init, headers });
}
