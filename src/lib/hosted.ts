import { getAccountScope } from '../auth/accountStorage';

export function viteEnv(): Record<string, string | undefined> {
  return (import.meta.env ?? {}) as Record<string, string | undefined>;
}

export function isHostedMode() {
  return viteEnv().VITE_MJH_HOSTED === 'true';
}

export function apiBase() {
  return (viteEnv().VITE_API_BASE || '').replace(/\/$/, '');
}

export function sourceUrl() {
  return viteEnv().VITE_SOURCE_URL || 'https://github.com/NOYESCLUBAI/manjinhai-canvas';
}

export function sourceVersion() {
  return viteEnv().VITE_APP_VERSION || '0.1.0';
}

/** Logged-in hosted sessions read and write the cloud library. Local mode stays on device. */
export function cloudActive() {
  return isHostedMode() && Boolean(getAccountScope());
}
