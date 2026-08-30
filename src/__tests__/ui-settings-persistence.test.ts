// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ELEG-64. These tests exist to prove that jsdom persistence is REAL here, and they are
 * written so that they cannot pass if it is not.
 *
 * The hazard being guarded against: `ui-settings.ts` wraps every storage access in
 * try/catch and falls back to defaults. Before ELEG-64, jsdom's default document was
 * `about:blank` — an opaque origin, for which jsdom refuses localStorage — so nothing
 * threw and nothing was logged, and a test asserting "the sort choice is persisted and
 * restored" would have exercised the catch branch, got defaults back, and passed for the
 * wrong reason whenever its expectations matched those defaults.
 *
 * Two rules for anything added here:
 *
 *  1. Never assert a value equal to the module's default. `theme` defaults to 'auto', so
 *     these use 'dark'; `listSort` defaults to `{}`, so these use a populated object.
 *     An assertion that matches the default cannot distinguish working storage from
 *     absent storage.
 *  2. Re-import the module rather than calling load twice. `ui-settings.ts` memoises in a
 *     module-level `cached`, so a second `loadUISettings()` in the same module instance
 *     returns the cache WITHOUT TOUCHING STORAGE — which would test the variable, not the
 *     persistence. `vi.resetModules()` + dynamic import is what simulates a page reload.
 */

const STORAGE_KEY = 'elegoo-web-ui-settings';

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe('the jsdom environment itself', () => {
  it('provides a real, working localStorage', () => {
    // The guard the whole file rests on. If this fails, every persistence assertion
    // below is meaningless, so it must fail loudly rather than be inferred.
    expect(typeof localStorage).toBe('object');
    localStorage.setItem('eleg-64-probe', 'stored');
    expect(localStorage.getItem('eleg-64-probe')).toBe('stored');
  });

  it('is served from a non-opaque origin, which is what makes that true', () => {
    expect(window.location.origin).toBe('http://localhost:3000');
  });
});

describe('ui-settings persistence', () => {
  it('writes saved settings through to the storage key', async () => {
    const { saveUISettings } = await import('../ui/ui-settings');
    saveUISettings({ theme: 'dark' });

    // Asserting on the raw storage entry, not on a getter — this is what proves the
    // value left the module and reached storage.
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).theme).toBe('dark');
  });

  it('restores a saved value across a module reload', async () => {
    const first = await import('../ui/ui-settings');
    first.saveUISettings({ theme: 'dark' });

    // Simulate a page reload: drop the module cache and import a fresh instance, which
    // must read from storage because its own `cached` starts null.
    vi.resetModules();
    const second = await import('../ui/ui-settings');

    // 'dark' is deliberately not the default ('auto'), so absent storage fails here.
    expect(second.loadUISettings().theme).toBe('dark');
  });

  it('restores a per-list sort choice across a module reload', async () => {
    const first = await import('../ui/ui-settings');
    first.saveListSort('files-list', { key: 'size', dir: 'desc' });

    vi.resetModules();
    const second = await import('../ui/ui-settings');

    // listSort defaults to {}, so getListSort would return undefined without storage.
    expect(second.getListSort('files-list')).toEqual({ key: 'size', dir: 'desc' });
  });

  it('restores a dropdown selection across a module reload', async () => {
    const first = await import('../ui/ui-settings');
    first.saveListSelect('files-list.status', 'failed');

    vi.resetModules();
    const second = await import('../ui/ui-settings');

    // The documented default for an absent selection is 'all'; 'failed' is not it.
    expect(second.getListSelect('files-list.status')).toBe('failed');
  });

  it('falls back to defaults when nothing is stored, without throwing', async () => {
    const { loadUISettings } = await import('../ui/ui-settings');
    expect(loadUISettings().theme).toBe('auto');
  });
});
