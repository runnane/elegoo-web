/**
 * The SPA's half of write auth (ELEG-139). Every REST write goes through `apiWrite()`
 * (or, for the XHR upload, `applyApiKey()` + `notifyIfUnauthorized()`), which adds
 * `Authorization: Bearer <key>` when the user has entered a key in Settings, and turns a
 * 401 into one clear message pointing at where the key goes.
 *
 * Reads do not send the key: they are open, and a stale key would turn them into 401s.
 */

import { fetchTimeout } from './helpers';
import { toast } from './toast';
import { loadUISettings, saveUISettings } from './ui-settings';

/** The Settings section heading — shared with the 401 message so the two cannot drift. */
export const API_KEY_SECTION = 'API key';

export const NEEDS_API_KEY_MESSAGE = `This needs the API key — enter it under Settings → ${API_KEY_SECTION}.`;

export function getApiKey(): string {
  return loadUISettings().apiKey ?? '';
}

export function setApiKey(key: string): void {
  saveUISettings({ apiKey: key.trim() });
}

/** `init` with `Authorization: Bearer` added when a key is stored; otherwise unchanged. */
export function withApiKey(init: RequestInit = {}): RequestInit {
  const key = getApiKey();
  if (!key) return init;
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${key}`);
  return { ...init, headers };
}

/** For the XHR upload, which cannot go through fetch (it needs progress events). */
export function applyApiKey(xhr: XMLHttpRequest): void {
  const key = getApiKey();
  if (key) xhr.setRequestHeader('Authorization', `Bearer ${key}`);
}

/** Shows the "needs the API key" message for a 401; returns whether it did. */
export function notifyIfUnauthorized(status: number): boolean {
  if (status !== 401) return false;
  toast(NEEDS_API_KEY_MESSAGE, 'error');
  return true;
}

/** A REST write: `fetchTimeout` with the key attached and a 401 explained. */
export async function apiWrite(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs?: number,
): Promise<Response> {
  const res = await fetchTimeout(input, withApiKey(init), timeoutMs);
  notifyIfUnauthorized(res.status);
  return res;
}
