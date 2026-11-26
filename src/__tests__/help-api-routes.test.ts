// @vitest-environment jsdom
/**
 * ELEG-172 — the Help tab's REST table cannot drift from the routes the server serves.
 *
 * The server registers `/api/*` routes as string comparisons spread over three modules
 * (no route table to import), so the route list is extracted from their source: every
 * `/api/<path>` literal, route doc comments included. A route added there without a row
 * in `REST_ROUTES` fails here; a row for a route that no longer exists fails too.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { REST_ROUTES } from '../ui/api-routes';
import { renderHelp } from '../ui/help';

const SERVER_FILES = ['rest-api.ts', 'print-queue-routes.ts', 'connection-presets.ts'];

function serverPaths(): Set<string> {
  const found = new Set<string>();
  for (const file of SERVER_FILES) {
    const src = readFileSync(resolve(__dirname, '../server', file), 'utf8');
    for (const m of src.matchAll(/\/api\/[A-Za-z0-9_:/-]+/g)) {
      const path = m[0].replace(/\/+$/, '');
      if (path !== '/api') found.add(path);
    }
  }
  return found;
}

describe('Help tab REST table', () => {
  it('extraction finds the known routes (guards the extractor itself)', () => {
    const paths = serverPaths();
    expect(paths.has('/api/health')).toBe(true);
    expect(paths.has('/api/queue/start-next')).toBe(true);
    expect(paths.has('/api/printers/:id/activate')).toBe(true);
    expect(paths.size).toBeGreaterThan(25);
  });

  it('lists every /api route the server serves', () => {
    const documented = new Set(REST_ROUTES.map((r) => r.path));
    const missing = [...serverPaths()].filter((p) => !documented.has(p));
    expect(missing).toEqual([]);
  });

  it('has no row for a route the server does not serve', () => {
    const served = serverPaths();
    // `/api/debug/captures/:file` is served as a `startsWith('/api/debug/captures/')`
    // prefix, so a parameterised row may match on the literal part before its first `:`.
    const stale = REST_ROUTES.map((r) => r.path).filter(
      (p) => !served.has(p) && !served.has(p.split('/:')[0]),
    );
    expect(stale).toEqual([]);
  });

  it('has no duplicate method+path rows', () => {
    const keys = REST_ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('marks exactly the non-GET routes, bar client-error, as needing the key', () => {
    for (const r of REST_ROUTES) {
      const expected =
        r.method !== 'GET' && !(r.method === 'POST' && r.path === '/api/client-error');
      expect(r.auth, `${r.method} ${r.path}`).toBe(expected);
    }
  });

  describe('rendered markup', () => {
    let html = '';
    beforeAll(() => {
      document.body.innerHTML = '<div id="help-content"></div>';
      renderHelp();
      html = document.getElementById('help-content')?.innerHTML ?? '';
    });

    it('contains a row for every route, with its method and key column', () => {
      for (const r of REST_ROUTES) {
        const row = `<tr><td>${r.method}</td><td>${r.path}</td>`;
        expect(html, `${r.method} ${r.path}`).toContain(row);
      }
      expect(html).toContain('<th>Key</th>');
    });

    it('no longer says the browser connects to the printer over MQTT', () => {
      expect(html).not.toContain('connects to the printer via MQTT');
      expect(html).toContain('<code>/ws</code>');
    });
  });
});
