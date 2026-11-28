// @vitest-environment jsdom
/**
 * ELEG-197 — the Retroactive Spool Estimator in the Spool Calculator (ported from
 * contributor PR #182).
 *
 * The estimator keeps its state at module scope, and `ui-settings.ts` memoises what it
 * read, so `localStorage.clear()` alone does not isolate one test from the next. Every
 * test therefore resets the module registry and imports the calculator afresh.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PAYLOAD = {
  reports: [
    {
      id: 'rep-pa-done',
      filename: 'sample_body.gcode',
      outcome: 'completed',
      startedAt: Date.UTC(2026, 10, 22, 12, 0, 0),
      endedAt: Date.UTC(2026, 10, 22, 22, 0, 0),
      duration: 36000,
      progressAtEnd: 99,
      filament: [
        {
          trayKey: 'canvas_0_tray_1',
          filamentType: 'PA',
          color: '#262626',
          extruded_mm: 80_000,
          grams: 220,
          meters: 80,
        },
      ],
    },
    {
      id: 'rep-pa-cancel',
      filename: 'sample_frame.gcode',
      outcome: 'failed',
      failureReason: 'Stopping',
      startedAt: Date.UTC(2026, 10, 21, 10, 0, 0),
      endedAt: Date.UTC(2026, 10, 21, 12, 0, 0),
      duration: 7200,
      progressAtEnd: 31,
      filament: [
        {
          trayKey: 'canvas_0_tray_1',
          filamentType: 'PA',
          color: '#262626',
          extruded_mm: 11_000,
          grams: 30,
          meters: 11,
        },
      ],
    },
    {
      id: 'rep-abs-done',
      filename: 'sample_box.gcode',
      outcome: 'completed',
      startedAt: Date.UTC(2026, 10, 20, 8, 0, 0),
      endedAt: Date.UTC(2026, 10, 20, 12, 0, 0),
      duration: 14400,
      progressAtEnd: 99,
      filament: [
        {
          trayKey: 'canvas_0_tray_0',
          filamentType: 'ABS',
          color: '#898989',
          extruded_mm: 75_000,
          grams: 190,
          meters: 75,
        },
      ],
    },
  ],
  active: false,
  activePrint: null,
};

const CALC_KEY = 'elegoo-web-spool-calc';
const SETTINGS_KEY = 'elegoo-web-ui-settings';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const text = (id: string) => $(id)?.textContent;

function select(id: string, value: string): void {
  const el = $<HTMLSelectElement>(id);
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function type(id: string, value: string): void {
  const el = $<HTMLInputElement>(id);
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function clickPreset(grams: number): void {
  (document.querySelector(`.sr-spool-preset[data-grams="${grams}"]`) as HTMLButtonElement).click();
}

async function mount(): Promise<void> {
  vi.resetModules();
  const { renderSpoolCalc } = await import('../ui/spool-calc');
  renderSpoolCalc();
  await flush();
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '<div id="tools-content"></div>';
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => PAYLOAD }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('estimator results', () => {
  it('lists the reports, filters by material (cancelled prints included), checks a planned print, and applies', async () => {
    await mount();
    // All three: 220 + 30 + 190 g
    expect(text('sr-used-grams')).toBe('440.0g');
    expect(document.querySelectorAll('#sr-list .sr-row')).toHaveLength(3);

    clickPreset(500);
    select('sr-filament', 'PA');
    expect(text('sr-used-grams')).toBe('250.0g');
    expect(text('sr-left-grams')).toBe('250.0g');
    expect(text('sr-selected-count')).toBe('2 / 2');

    type('sr-planned-grams', '300');
    expect(text('sr-check-val')).toBe('Short (-50.0g)');

    const cancel = document.querySelector('.sr-check[data-id="rep-pa-cancel"]') as HTMLInputElement;
    cancel.checked = false;
    cancel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(text('sr-used-grams')).toBe('220.0g');
    expect(text('sr-left-grams')).toBe('280.0g');

    // Empty spool 250 g (default) → full 750 g, current 530 g, 280 g of filament
    $('sr-apply').click();
    expect(text('sr-apply-status')).toMatch(/^Applied 280g remaining/);
    expect($<HTMLInputElement>('sc-full-weight').value).toBe('750');
    expect($<HTMLInputElement>('sc-current-weight').value).toBe('530');
    expect(text('sc-grams')).toBe('280');
    expect($<HTMLSelectElement>('sc-material').value).toBe('PA');
    const saved = JSON.parse(localStorage.getItem(CALC_KEY) ?? '{}');
    expect(saved).toMatchObject({ fullWeight: 750, currentWeight: 530, material: 'PA' });
  });

  it('keeps focus in a per-print gram override while the totals update', async () => {
    await mount();
    clickPreset(500);
    select('sr-filament', 'PA');

    const input = document.querySelector(
      '.sr-grams-input[data-id="rep-pa-cancel"]',
    ) as HTMLInputElement;
    input.focus();
    input.value = '55';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    expect(document.activeElement).toBe(input);
    expect(text('sr-used-grams')).toBe('275.0g');
    expect(text('sr-left-grams')).toBe('225.0g');
  });
});

describe('Apply goes through validateSpool (ELEG-170)', () => {
  it('refuses an estimate that used more than the spool held, shows the error and saves nothing', async () => {
    localStorage.setItem(CALC_KEY, JSON.stringify({ currentWeight: 900 }));
    await mount();
    clickPreset(250); // 440 g used of 250 g → current weight 60 g, below the 250 g empty spool

    $('sr-apply').click();

    expect(text('sr-apply-status')).toMatch(
      /^Not applied: Current weight cannot be below the empty spool weight\./,
    );
    expect($('sr-apply-status').classList.contains('sr-status-danger')).toBe(true);
    const err = $('sc-err-currentWeight');
    expect(err.hidden).toBe(false);
    expect($('sc-current-weight').getAttribute('aria-invalid')).toBe('true');
    expect(text('sc-percent')).toBe('—');
    // The last valid values stay in storage.
    expect(JSON.parse(localStorage.getItem(CALC_KEY) ?? '{}').currentWeight).toBe(900);
  });

  it('refuses a zero starting spool (full weight equal to empty)', async () => {
    await mount();
    type('sr-start-grams', '0');
    $('sr-apply').click();
    expect(text('sr-apply-status')).toMatch(/^Not applied: /);
    expect(text('sc-err-fullWeight')).toBe(
      'Full weight must be greater than the empty spool weight.',
    );
    expect($('sc-err-fullWeight').hidden).toBe(false);
    expect(localStorage.getItem(CALC_KEY)).toBeNull();
  });
});

describe('density override', () => {
  it('is unavailable across mixed materials and ignored even if previously chosen', async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ spoolRetro: { densityMode: 'PA-CF' } }));
    await mount();

    expect($<HTMLSelectElement>('sr-density-mode').disabled).toBe(true);
    expect(text('sr-density-note')).toMatch(/Mixed materials use the recorded grams/);
    // Recorded grams, not 166 000 mm at 1.17 g/cm³
    expect(text('sr-used-grams')).toBe('440.0g');
  });

  it('is available for a single material and recomputes grams from length', async () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ spoolRetro: { densityMode: 'PA-CF' } }));
    await mount();
    select('sr-filament', 'PA');

    expect($<HTMLSelectElement>('sr-density-mode').disabled).toBe(false);
    expect(text('sr-density-note')).toMatch(/for PA/);
    // 9100 cm × 0.0240528 cm² × 1.17 g/cm³ = 256.09 g
    expect(text('sr-used-grams')).toBe('256.1g');

    select('sr-filament', 'ALL');
    expect($<HTMLSelectElement>('sr-density-mode').disabled).toBe(true);
    expect(text('sr-used-grams')).toBe('440.0g');
  });
});

describe('controls are a static sibling of the results (AGENTS.md list-view rule)', () => {
  it('keeps focus and value in a filter input while the list re-renders', async () => {
    await mount();
    const since = $<HTMLInputElement>('sr-since');
    since.focus();
    since.value = '2026-11-21T00:00';
    since.dispatchEvent(new Event('change', { bubbles: true }));

    expect(document.querySelectorAll('#sr-list .sr-row')).toHaveLength(2);
    expect(document.activeElement).toBe(since);
    expect($<HTMLInputElement>('sr-since').value).toBe('2026-11-21T00:00');
  });

  it('keeps focus in a control across a refresh that replaces the whole list', async () => {
    await mount();
    const planned = $<HTMLInputElement>('sr-planned-grams');
    planned.focus();
    type('sr-planned-grams', '12.5');
    const rowBefore = document.querySelector('#sr-list .sr-row');

    $('sr-refresh').click();
    await flush();

    expect(document.querySelector('#sr-list .sr-row')).not.toBe(rowBefore);
    expect(document.activeElement).toBe(planned);
    expect(planned.value).toBe('12.5');
  });

  it('counterfactual: an input inside the re-rendered list does lose focus on refresh', async () => {
    await mount();
    const rowInput = document.querySelector('.sr-grams-input') as HTMLInputElement;
    rowInput.focus();
    expect(document.activeElement).toBe(rowInput);

    $('sr-refresh').click();
    await flush();

    expect(document.activeElement).not.toBe(rowInput);
    expect(rowInput.isConnected).toBe(false);
  });
});

describe('preferences live in ui-settings', () => {
  it('persists through ui-settings and survives a reload, with no key of its own', async () => {
    await mount();
    clickPreset(2000);
    select('sr-filament', 'ABS');

    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}');
    expect(stored.spoolRetro).toMatchObject({ startingSpoolGrams: 2000, filamentFilter: 'ABS' });
    expect(localStorage.getItem('elegoo-web-spool-retro')).toBeNull();

    document.body.innerHTML = '<div id="tools-content"></div>';
    await mount();
    expect($<HTMLInputElement>('sr-start-grams').value).toBe('2000');
    expect($<HTMLSelectElement>('sr-filament').value).toBe('ABS');
    expect(text('sr-used-grams')).toBe('190.0g');
  });
});
