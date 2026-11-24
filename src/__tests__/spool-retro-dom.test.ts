// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderSpoolCalc } from '../ui/spool-calc';

const MOCK_REPORTS_PAYLOAD = {
  reports: [
    {
      id: 'rep-pa-done',
      filename: 'body_PA6CF.gcode',
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
      filename: 'frame_PA6CF.gcode',
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
      filename: 'drybox_ABS.gcode',
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

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('spool-calc retroactive UI', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '<div id="tools-content"></div><div id="toast-container"></div>';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => MOCK_REPORTS_PAYLOAD,
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads print reports, filters by filament type (incl. canceled), checks planned print, and applies to calculator', async () => {
    renderSpoolCalc();
    await flushMicrotasks();

    // Default loads all 3 non-zero prints: 220 + 30 + 190 = 440g
    expect(document.getElementById('sr-used-grams')?.textContent).toBe('440.0g');

    // Select 500g spool preset
    const preset500 = document.querySelector(
      '.sr-spool-preset[data-grams="500"]',
    ) as HTMLButtonElement;
    preset500.click();

    // Filter to PA -> 220g completed + 30g canceled = 250g used, 250g left
    const filamentSelect = document.getElementById('sr-filament') as HTMLSelectElement;
    filamentSelect.value = 'PA';
    filamentSelect.dispatchEvent(new Event('change'));

    expect(document.getElementById('sr-used-grams')?.textContent).toBe('250.0g');
    expect(document.getElementById('sr-left-grams')?.textContent).toBe('250.0g');
    expect(document.getElementById('sr-selected-count')?.textContent).toBe('2 / 2');

    // Check against a 300g planned print -> Short (-50.0g)
    const plannedInput = document.getElementById('sr-planned-grams') as HTMLInputElement;
    plannedInput.value = '300';
    plannedInput.dispatchEvent(new Event('input'));
    expect(document.getElementById('sr-check-val')?.textContent).toBe('Short (-50.0g)');

    // Uncheck the canceled print -> only 220g used, 280g left
    const cancelCheck = document.querySelector(
      '.sr-check[data-id="rep-pa-cancel"]',
    ) as HTMLInputElement;
    cancelCheck.checked = false;
    cancelCheck.dispatchEvent(new Event('change'));
    expect(document.getElementById('sr-used-grams')?.textContent).toBe('220.0g');
    expect(document.getElementById('sr-left-grams')?.textContent).toBe('280.0g');

    // Apply to main Spool Calculator (empty default 250g -> full 750g, current 530g, filament 280g)
    const applyBtn = document.getElementById('sr-apply') as HTMLButtonElement;
    applyBtn.click();

    expect((document.getElementById('sc-full-weight') as HTMLInputElement).value).toBe('750');
    expect((document.getElementById('sc-current-weight') as HTMLInputElement).value).toBe('530');
    expect(document.getElementById('sc-grams')?.textContent).toBe('280');
    expect((document.getElementById('sc-material') as HTMLSelectElement).value).toBe('PA');
  });

  it('allows overriding actual grams on a print row without losing input focus', async () => {
    renderSpoolCalc();
    await flushMicrotasks();

    const preset500 = document.querySelector(
      '.sr-spool-preset[data-grams="500"]',
    ) as HTMLButtonElement;
    preset500.click();

    const filamentSelect = document.getElementById('sr-filament') as HTMLSelectElement;
    filamentSelect.value = 'PA';
    filamentSelect.dispatchEvent(new Event('change'));

    const overrideInput = document.querySelector(
      '.sr-grams-input[data-id="rep-pa-cancel"]',
    ) as HTMLInputElement;
    overrideInput.focus();
    overrideInput.value = '55';
    overrideInput.dispatchEvent(new Event('input'));

    expect(document.activeElement).toBe(overrideInput);
    expect(document.getElementById('sr-used-grams')?.textContent).toBe('275.0g');
    expect(document.getElementById('sr-left-grams')?.textContent).toBe('225.0g');
  });
});
