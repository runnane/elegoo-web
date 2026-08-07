/**
 * Layer-report classification (ELEG-16).
 *
 * The repro these are built from is real. The running service returned 64 layer entries
 * whose **first** element was `{layer: 29, duration: 155.259}` — the previous job's last
 * layer, timed across the gap before the new job reached layer 1. The printer keeps
 * reporting the finished job's `current_layer` for a moment after a print ends, so the
 * new job's first report arrives as a *drop*, and timing that drop invents an entry that
 * belongs to neither print. It sits in front of the new series, leaving `layerTimes`
 * non-monotonic — which is what made the layer chart paint outside its own axes.
 *
 * This file lives under `src/server/` for the same reason as `mcp-doc-parity.test.ts`:
 * `tsconfig.json` excludes that directory, so importing server code from
 * `src/__tests__/` would drag Node-only modules into the browser typecheck. Here it is
 * covered by `pnpm service:check`. The chart half is tested separately, in
 * `src/__tests__/layer-chart.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { classifyLayerReport } from '../state-store.js';

const T0 = 1_786_110_795_370;

describe('classifyLayerReport', () => {
  it('records a layer that genuinely completed', () => {
    const r = classifyLayerReport(4, T0, 5, T0 + 13_000);
    expect(r.action).toBe('record');
    expect(r.durationSec).toBe(13);
  });

  it('ignores a repeat of the layer already being tracked', () => {
    expect(classifyLayerReport(5, T0, 5, T0 + 13_000).action).toBe('ignore');
  });

  it('only starts the clock when there is nothing to time against', () => {
    expect(classifyLayerReport(0, 0, 29, T0).action).toBe('baseline');
    expect(classifyLayerReport(29, 0, 30, T0).action).toBe('baseline');
  });

  it('treats a layer going backwards as a print boundary, not a completed layer', () => {
    // The exact live repro: L29 was still being reported from the finished job when the
    // new job's first real report arrived, 155s later, as L1.
    const r = classifyLayerReport(29, T0, 1, T0 + 155_259);
    expect(r.action).toBe('boundary');
    // The cross-print gap must not survive as a duration.
    expect(r.durationSec).toBe(0);
  });

  it('treats any decrease as a boundary, not just a drop to layer 1', () => {
    expect(classifyLayerReport(120, T0, 119, T0 + 15_000).action).toBe('boundary');
  });

  it('discards an implausible duration rather than plotting it', () => {
    expect(classifyLayerReport(4, T0, 5, T0 + 601_000).action).toBe('discard');
    expect(classifyLayerReport(4, T0, 5, T0 + 599_000).action).toBe('record');
  });

  it('never reports a duration for anything it did not record', () => {
    for (const r of [
      classifyLayerReport(5, T0, 5, T0 + 13_000),
      classifyLayerReport(0, 0, 29, T0),
      classifyLayerReport(29, T0, 1, T0 + 155_259),
    ]) {
      expect(r.durationSec).toBe(0);
    }
  });
});
