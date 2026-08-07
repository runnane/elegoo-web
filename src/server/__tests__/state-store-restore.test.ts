/**
 * StateStore.restoreLayerData sanitisation (ELEG-18).
 *
 * This is the first test in the repo that stands up a real `StateStore`. It needs no
 * printer and opens no connection: the constructor only registers listeners on the bridge
 * it is handed, so an EventEmitter stub satisfies it. It *does* start a chart-sampling
 * interval, hence the `destroy()` in afterEach — without it vitest never exits.
 *
 * What is being pinned: a `data/state.json` written before ELEG-16 can carry an entry
 * from a previous print, and `StatePersistence.load()` accepts a snapshot up to 24h old.
 * Everything downstream reads `store.layerTimes` raw — `/api/metrics`' average, the MCP
 * `layers` tool, `computeLayerStats` in the report collector — so if the corruption gets
 * past this boundary it reaches all of them.
 */

import { EventEmitter } from 'events';
import { describe, it, expect, afterEach } from 'vitest';
import { StateStore } from '../state-store.js';
import type { MqttBridge } from '../mqtt-bridge.js';

const T0 = 1_786_110_795_370;
const entry = (layer: number, duration: number) => ({
  layer,
  duration,
  timestamp: T0 + layer * 1000,
});

let store: StateStore | null = null;

function makeStore(): StateStore {
  // The constructor only calls bridge.on(); nothing in the restore path touches it.
  const bridge = new EventEmitter() as unknown as MqttBridge;
  store = new StateStore(bridge, 25);
  return store;
}

afterEach(() => {
  store?.destroy();
  store = null;
});

describe('StateStore.restoreLayerData', () => {
  it('drops a previous print carried in by a stale state.json', () => {
    // The live repro, verbatim: L29 from the finished job in front of L1–L3.
    const s = makeStore();
    s.restoreLayerData([entry(29, 155.259), entry(1, 33), entry(2, 24), entry(3, 20)], 4, T0);

    expect(s.layerTimes.map((l) => l.layer)).toEqual([1, 2, 3]);
    // The 155s cross-print duration is what skewed every consumer's average.
    expect(Math.max(...s.layerTimes.map((l) => l.duration))).toBe(33);
  });

  it('leaves a healthy series untouched', () => {
    const s = makeStore();
    const series = [entry(1, 33), entry(2, 24), entry(3, 20)];
    s.restoreLayerData(series, 4, T0);
    expect(s.layerTimes).toEqual(series);
  });

  it('keeps the persisted baseline, which still describes the surviving tail', () => {
    const s = makeStore();
    s.restoreLayerData([entry(29, 155.259), entry(1, 33), entry(2, 24)], 3, T0 + 9999);
    // Entries are only ever dropped from the front, so the layer in progress is unchanged.
    expect(s.getLastLayer()).toBe(3);
    expect(s.getLastLayerTime()).toBe(T0 + 9999);
  });

  it('ignores an empty restore rather than clobbering live data', () => {
    const s = makeStore();
    const series = [entry(1, 33), entry(2, 24)];
    s.restoreLayerData(series, 3, T0);
    s.restoreLayerData([], 0, 0);
    expect(s.layerTimes).toEqual(series);
    expect(s.getLastLayer()).toBe(3);
  });
});
