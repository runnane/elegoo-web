// @vitest-environment jsdom
/**
 * ELEG-139: the SPA's half of write auth (`src/ui/api-key.ts`). The key persists through
 * `ui-settings.ts` across a reload, a write carries `Authorization: Bearer` only when a key
 * is stored, and a 401 produces the message that names the Settings section.
 *
 * Re-imports after `vi.resetModules()` simulate a page reload, per the rules in
 * `ui-settings-persistence.test.ts` (a second load in one module instance reads the cache).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'c'.repeat(40); // generated, not a real key

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe('api-key', () => {
  it('persists the key across a reload, trimmed', async () => {
    const first = await import('../ui/api-key');
    first.setApiKey(`  ${KEY}\n`);
    vi.resetModules();
    const second = await import('../ui/api-key');
    expect(second.getApiKey()).toBe(KEY);
  });

  it('adds Authorization: Bearer when a key is stored', async () => {
    const m = await import('../ui/api-key');
    m.setApiKey(KEY);
    const init = m.withApiKey({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe(`Bearer ${KEY}`);
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('sends no Authorization header when no key is stored', async () => {
    const m = await import('../ui/api-key');
    const init = m.withApiKey({ method: 'POST' });
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
  });

  it('apiWrite sends the key and shows the Settings message on a 401', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetchSpy);
    const m = await import('../ui/api-key');
    m.setApiKey(KEY);
    const res = await m.apiWrite('/api/queue/clear', { method: 'POST' });
    expect(res.status).toBe(401);
    const sent = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(sent[1].headers).get('Authorization')).toBe(`Bearer ${KEY}`);
    expect(document.body.textContent).toContain(m.NEEDS_API_KEY_MESSAGE);
    expect(m.NEEDS_API_KEY_MESSAGE).toContain(`Settings → ${m.API_KEY_SECTION}`);
  });
});
