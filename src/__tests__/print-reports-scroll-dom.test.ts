// @vitest-environment jsdom
/**
 * ELEG-173 — the Print Reports list scrolls inside its card like Print History does,
 * and its per-row delete button is the same ghost style the history rows use.
 *
 * The scroll rule lives on `.print-history-entries`; reports reuse the class instead of
 * copying the numbers, so this pins that the two cannot silently diverge.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { refreshReports } from '../ui/print-reports';

const root = resolve(__dirname, '../..');

function shellFromIndexHtml(): void {
  const html = readFileSync(resolve(root, 'index.html'), 'utf8');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  document.body.innerHTML = '';
  for (const id of ['print-history-entries', 'print-reports-controls', 'print-reports-entries']) {
    const el = doc.getElementById(id);
    if (!el) throw new Error(`index.html has no #${id}`);
    document.body.appendChild(document.importNode(el, true));
  }
}

describe('Print Reports list (ELEG-173)', () => {
  it('carries the same scroll class as the Print History list', () => {
    shellFromIndexHtml();
    const history = document.getElementById('print-history-entries');
    const reports = document.getElementById('print-reports-entries');
    expect(history?.classList.contains('print-history-entries')).toBe(true);
    expect(reports?.classList.contains('print-history-entries')).toBe(true);
  });

  it('the shared class bounds the height and scrolls', () => {
    const css = readFileSync(resolve(root, 'src/styles/main.css'), 'utf8');
    const rule = /\.print-history-entries\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule?.[1]).toMatch(/max-height:\s*\d+px/);
    expect(rule?.[1]).toMatch(/overflow-y:\s*auto/);
  });

  it('renders the per-row delete button as a ghost button, not a danger one', async () => {
    shellFromIndexHtml();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        active: false,
        reports: [
          {
            id: 'r1',
            filename: 'a.gcode',
            outcome: 'completed',
            startedAt: 1,
            endedAt: 2,
            duration: 1,
          },
        ],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    refreshReports();
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.report-delete-btn').length).toBe(1);
    });
    const del = document.querySelector('.report-delete-btn') as HTMLElement;
    expect(del.classList.contains('btn-ghost')).toBe(true);
    expect(del.classList.contains('btn-danger')).toBe(false);
    vi.unstubAllGlobals();
  });
});
