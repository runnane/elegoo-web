// @vitest-environment jsdom
/**
 * ELEG-157 — the locked notice in Settings → Printer connections must describe the
 * security posture as it is since ELEG-139: presets writes take `SERVICE_API_KEY` when one
 * is set. It used to claim "the API has no authentication", which became false.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountPrinterPresets } from '../ui/printer-presets';

beforeEach(() => {
  document.body.innerHTML = '';
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ presets: [], writable: false }))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mountPrinterPresets — locked notice', () => {
  it('says the changes need SERVICE_API_KEY and no longer claims the API is unauthenticated', () => {
    const root = document.createElement('div');
    document.body.append(root);
    mountPrinterPresets(root);
    const hint = root.querySelector('#printer-presets-controls p.settings-hint');
    const text = hint?.textContent ?? '';
    expect(text).toContain('SERVICE_API_KEY');
    expect(text).toContain('need the API key');
    expect(text).toContain('Without a key, anyone who can reach the service could re-point it');
    expect(text).not.toContain('has no authentication');
  });
});
