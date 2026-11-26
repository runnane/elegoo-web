// @vitest-environment jsdom
/**
 * ELEG-174 — the committed dashboard markup: every card heading matches the name
 * Settings → Panel Layout shows for it, the auxiliary fan is called that, and the form
 * controls a screen reader announced as unlabelled now carry an accessible name.
 *
 * Reads the real index.html, not a hand-copied fixture, so a change to the markup is
 * what this sees.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ALL_CARD_IDS, CARD_NAMES } from '../ui/card-layout';

const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');
let doc: Document;

beforeAll(() => {
  doc = new DOMParser().parseFromString(html, 'text/html');
});

/** The accessible name a control gets from aria-label, aria-labelledby, a label or title. */
function accessibleName(el: Element): string {
  const aria = el.getAttribute('aria-label')?.trim();
  if (aria) return aria;
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => doc.getElementById(id)?.textContent?.trim() ?? '')
      .join(' ')
      .trim();
    if (text) return text;
  }
  if (el.id) {
    const forLabel = doc.querySelector(`label[for="${el.id}"]`)?.textContent?.trim();
    if (forLabel) return forLabel;
  }
  const wrapping = el.closest('label')?.textContent?.trim();
  if (wrapping) return wrapping;
  return el.getAttribute('title')?.trim() ?? '';
}

describe('dashboard card names (ELEG-174)', () => {
  it.each(ALL_CARD_IDS)('%s: its <h3> is the name Panel Layout shows', (id) => {
    const heading = doc.querySelector(`#${id} h3`);
    expect(heading, `#${id} has no h3`).not.toBeNull();
    expect(heading?.textContent?.trim()).toBe(CARD_NAMES[id]);
  });

  it('pins the three names that used to differ', () => {
    expect(CARD_NAMES['fans-card']).toBe('🌀 Fans & Light');
    expect(CARD_NAMES['toolhead-card']).toBe('🎯 Control');
    expect(CARD_NAMES['gcode-preview-card']).toBe('📐 G-code Preview');
  });
});

describe('fan labels (ELEG-174)', () => {
  it('calls aux_fan "Auxiliary", not "Assistance"', () => {
    const item = doc.querySelector('[data-fan="aux_fan"]')?.closest('.fan-item');
    expect(item?.querySelector('.fan-label')?.textContent?.trim()).toBe('Auxiliary');
    expect(html).not.toContain('Assistance');
  });
});

describe('speed unit (ELEG-174)', () => {
  it('starts the speed readout in mm/s, the unit renderDashboard writes', () => {
    expect(doc.getElementById('live-speed')?.textContent?.trim()).toBe('-- mm/s');
  });
});

describe('accessible names (ELEG-174)', () => {
  const controls = [
    'set-nozzle-temp',
    'set-bed-temp',
    'gcode-layer-slider',
    'slog-search',
    'slog-direction-filter',
    'slog-type-filter',
    'slog-method-filter',
  ];

  it.each(controls)('#%s has an accessible name', (id) => {
    const el = doc.getElementById(id);
    expect(el, `index.html has no #${id}`).not.toBeNull();
    expect(accessibleName(el as Element)).not.toBe('');
  });

  it('the name helper is not vacuous: an unlabelled control has none', () => {
    const probe = new DOMParser().parseFromString('<input id="x">', 'text/html');
    const saved = doc;
    doc = probe;
    try {
      expect(accessibleName(probe.getElementById('x') as Element)).toBe('');
    } finally {
      doc = saved;
    }
  });
});
