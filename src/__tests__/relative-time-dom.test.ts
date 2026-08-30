// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ELEG-45. The claim under test is the one the issue warns about: a relative timestamp
 * written once and never updated is worse than a clock.
 *
 * These assert the *refresh* path specifically, and that it works **without a
 * re-render** — which is what keeps the log's auto-scroll, pause button and expanded
 * rows intact. `renderLog` also short-circuits when nothing changed, so a
 * re-render-based approach would silently do nothing at all.
 */

const NOW = 1_700_000_000_000;

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  document.body.innerHTML = '';
});

/** Mount one timestamp span of the shape the three render sites emit. */
function mountSpan(ts: number, abs: string) {
  document.body.innerHTML = `<span class="log-time" data-ts="${ts}" data-abs="${abs}" title="${abs}">${abs}</span>`;
  return document.querySelector('.log-time') as HTMLElement;
}

describe('refreshTimestamps', () => {
  it('leaves the absolute text alone while the setting is off', async () => {
    const { refreshTimestamps } = await import('../ui/relative-time');
    const el = mountSpan(NOW - 120_000, '12:34:56.000');

    refreshTimestamps(NOW);

    // Off by default, so this must not have become "2m ago".
    expect(el.textContent).toBe('12:34:56.000');
  });

  it('rewrites the text to a relative age once the setting is on', async () => {
    const { saveUISettings } = await import('../ui/ui-settings');
    saveUISettings({ relativeTimestamps: true });
    const { refreshTimestamps } = await import('../ui/relative-time');
    const el = mountSpan(NOW - 120_000, '12:34:56.000');

    refreshTimestamps(NOW);

    expect(el.textContent).toBe('2m ago');
  });

  it('advances the age on a later refresh — the whole point of the ticker', async () => {
    const { saveUISettings } = await import('../ui/ui-settings');
    saveUISettings({ relativeTimestamps: true });
    const { refreshTimestamps } = await import('../ui/relative-time');
    const el = mountSpan(NOW, 'irrelevant');

    refreshTimestamps(NOW + 60_000);
    expect(el.textContent).toBe('1m ago');

    // A stale "1m ago" is exactly the defect the issue describes, so assert it moves.
    refreshTimestamps(NOW + 300_000);
    expect(el.textContent).toBe('5m ago');
  });

  it('keeps the absolute value in the title in BOTH modes', async () => {
    const { saveUISettings } = await import('../ui/ui-settings');
    const { refreshTimestamps } = await import('../ui/relative-time');
    const el = mountSpan(NOW - 120_000, '12:34:56.000');

    refreshTimestamps(NOW);
    expect(el.title).toBe('12:34:56.000');

    saveUISettings({ relativeTimestamps: true });
    refreshTimestamps(NOW);
    expect(el.textContent).toBe('2m ago');
    // Hovering must still give the precise value — this is a toggle, not a replacement.
    expect(el.title).toBe('12:34:56.000');
  });

  it('can switch back to absolute without a re-render', async () => {
    const { saveUISettings } = await import('../ui/ui-settings');
    saveUISettings({ relativeTimestamps: true });
    const { refreshTimestamps } = await import('../ui/relative-time');
    const el = mountSpan(NOW - 120_000, '12:34:56.000');

    refreshTimestamps(NOW);
    expect(el.textContent).toBe('2m ago');

    saveUISettings({ relativeTimestamps: false });
    refreshTimestamps(NOW);
    // Restored from data-abs, so the render sites never have to be involved.
    expect(el.textContent).toBe('12:34:56.000');
  });

  it('does not replace the element, so listeners and scroll state survive', async () => {
    const { saveUISettings } = await import('../ui/ui-settings');
    saveUISettings({ relativeTimestamps: true });
    const { refreshTimestamps } = await import('../ui/relative-time');
    const el = mountSpan(NOW - 120_000, '12:34:56.000');

    let clicks = 0;
    el.addEventListener('click', () => {
      clicks++;
    });

    refreshTimestamps(NOW);

    // Identity, not just equality: an innerHTML rebuild would give a different node and
    // silently drop the listener. This is the property that protects the auto-scroll.
    expect(document.querySelector('.log-time')).toBe(el);
    el.click();
    expect(clicks).toBe(1);
  });

  it('ignores elements without the timestamp attributes', async () => {
    const { refreshTimestamps } = await import('../ui/relative-time');
    document.body.innerHTML = `<span class="log-time">untouched</span>`;

    refreshTimestamps(NOW);

    expect((document.querySelector('.log-time') as HTMLElement).textContent).toBe('untouched');
  });
});
