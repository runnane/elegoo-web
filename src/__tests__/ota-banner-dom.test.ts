// @vitest-environment jsdom
/**
 * ELEG-98 — the "do not power off" banner as a human actually sees it, using the
 * jsdom environment ELEG-61 added. See `list-controls-dom.test.ts` for the
 * conventions.
 *
 * The pure decision — which sub_status counts as OTA, and which of those are the
 * in-progress window — is tested in `types.test.ts`. What is asserted here is the
 * wiring: that the banner element actually shows/hides/changes text off the live
 * `sub_status`, with no client-side storage involved (a fresh mount with no prior
 * call renders nothing, which is what "derived from live state" means in practice).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { renderOtaBanner } from '../ui/print-status';

function mountShell() {
  document.body.innerHTML = '<div id="ota-banner" class="ota-banner hidden"></div>';
  return document.getElementById('ota-banner') as HTMLElement;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('renderOtaBanner — in-progress codes', () => {
  it('shows the do-not-power-off banner for 2601 OTAInfoUpdating', () => {
    const banner = mountShell();
    renderOtaBanner(2601);
    expect(banner.classList.contains('hidden')).toBe(false);
    expect(banner.textContent).toMatch(/do not power off/i);
  });

  it('shows the do-not-power-off banner for 2701 OTADownloading, 2702 OTAExtracting, 2703 OTAUpdating', () => {
    for (const code of [2701, 2702, 2703]) {
      const banner = mountShell();
      renderOtaBanner(code);
      expect(banner.classList.contains('hidden'), `code ${code}`).toBe(false);
      expect(banner.textContent, `code ${code}`).toMatch(/do not power off/i);
      expect(banner.className, `code ${code}`).toContain('ota-banner-active');
    }
  });
});

describe('renderOtaBanner — terminal codes get a calmer message', () => {
  it('shows a complete message for 2704, without the power-off warning', () => {
    const banner = mountShell();
    renderOtaBanner(2704);
    expect(banner.classList.contains('hidden')).toBe(false);
    expect(banner.textContent).toMatch(/complete/i);
    expect(banner.textContent).not.toMatch(/do not power off/i);
  });

  it('shows a failed message for 2705, without the power-off warning', () => {
    const banner = mountShell();
    renderOtaBanner(2705);
    expect(banner.classList.contains('hidden')).toBe(false);
    expect(banner.textContent).toMatch(/failed/i);
    expect(banner.textContent).not.toMatch(/do not power off/i);
  });
});

describe('renderOtaBanner — hidden the rest of the time', () => {
  it('stays hidden for a normal printing sub-status', () => {
    const banner = mountShell();
    renderOtaBanner(2075); // Printing
    expect(banner.classList.contains('hidden')).toBe(true);
    expect(banner.textContent).toBe('');
  });

  it('stays hidden for an undefined sub_status (idle, or a stale payload)', () => {
    const banner = mountShell();
    renderOtaBanner(undefined);
    expect(banner.classList.contains('hidden')).toBe(true);
  });

  it('hides again once the printer moves on from an OTA code to a normal one', () => {
    const banner = mountShell();
    renderOtaBanner(2703);
    expect(banner.classList.contains('hidden')).toBe(false);
    renderOtaBanner(1);
    expect(banner.classList.contains('hidden')).toBe(true);
    expect(banner.textContent).toBe('');
  });

  it('renders nothing on a fresh mount with no prior call — no client-side storage to fall back to', () => {
    const banner = mountShell();
    expect(banner.classList.contains('hidden')).toBe(true);
    expect(banner.textContent).toBe('');
  });
});
