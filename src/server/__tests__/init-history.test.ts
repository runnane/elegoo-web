/**
 * ELEG-194: the chart history an `init` frame carries is bounded, whatever the store holds.
 * Fixtures are generated: the field set of a real `sampleChart()` / AI point, with values
 * that serialize at realistic length.
 */
import { EventEmitter } from 'events';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { MqttBridge } from '../mqtt-bridge.js';
import type { AIChartPoint, ChartPoint, StateStore } from '../state-store.js';
import { WebSocketTransport } from '../ws-transport.js';
import {
  INIT_AI_CHART_MAX_POINTS,
  INIT_CHART_FULL_RES_POINTS,
  INIT_CHART_MAX_POINTS,
  INIT_EVENT_LOG_MAX_ENTRIES,
  INIT_HISTORY_MAX_BYTES,
  INIT_LAYER_TIMES_MAX_ENTRIES,
  boundHistory,
  boundInitHistory,
  boundTail,
} from '../init-history.js';

/** `MAX_BACKLOG` in ws-transport.ts, pinned as a literal so the two cannot drift together */
const MAX_BACKLOG = 32 * 1024 * 1024;
const T0 = 1_764_000_000_000;

/** The eleven values `StateStore.sampleChart()` records, at 1 Hz */
function chartPoints(n: number): ChartPoint[] {
  const out: ChartPoint[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      t: T0 + i * 1000,
      values: {
        nozzle: 214.7 + (i % 7) / 10,
        nozzle_tgt: 220,
        bed: 59.8 + (i % 5) / 10,
        bed_tgt: 60,
        chamber: 34.6 + (i % 3) / 10,
        fan_model: 100,
        fan_aux: 45,
        fan_case: 30,
        extrusion_rate: 2.37,
        flow_rate: 5.71,
        mass_flow_rate: 0.007,
      },
    });
  }
  return out;
}

/** Motion plus the five SigLIP class scores `main.ts` reads */
function aiPoints(n: number): AIChartPoint[] {
  const out: AIChartPoint[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      t: T0 + i * 1000,
      motion: 0.0123 + (i % 11) / 1000,
      scores: {
        'Print in Progress': 0.9312,
        'Spaghetti/Failure': 0.0121,
        'Empty Bed': 0.0234,
        'Paused/Stopped': 0.0187,
        Other: 0.0146,
      },
    });
  }
  return out;
}

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

describe('boundInitHistory on a full store (300,000 + 300,000 points)', () => {
  const chart = chartPoints(300_000);
  const ai = aiPoints(300_000);

  it('the fixture is hostile: sent whole, it is past MAX_BACKLOG', () => {
    expect(bytes({ chartHistory: chart, aiChartHistory: ai })).toBeGreaterThan(MAX_BACKLOG);
  });

  it('serializes under the 8 MiB budget, far below MAX_BACKLOG', () => {
    const out = boundInitHistory(chart, ai);
    expect(bytes(out)).toBeLessThanOrEqual(INIT_HISTORY_MAX_BYTES);
    expect(bytes(out)).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(out.chartHistory).toHaveLength(INIT_CHART_MAX_POINTS);
    expect(out.aiChartHistory).toHaveLength(INIT_AI_CHART_MAX_POINTS);
  });

  it('keeps the newest points, the last hour whole, and the order', () => {
    const out = boundInitHistory(chart, ai);
    expect(out.chartHistory.at(-1)).toBe(chart.at(-1));
    expect(out.aiChartHistory.at(-1)).toBe(ai.at(-1));
    // The last hour is the store's own tail, untouched.
    expect(out.chartHistory.slice(-INIT_CHART_FULL_RES_POINTS)).toEqual(
      chart.slice(-INIT_CHART_FULL_RES_POINTS),
    );
    // The AI history is a plain tail: the browser keeps no more than that per series.
    expect(out.aiChartHistory).toEqual(ai.slice(-INIT_AI_CHART_MAX_POINTS));
    // Older points are spread back to the very first, so the time span survives.
    expect(out.chartHistory[0]).toBe(chart[0]);
    for (let i = 1; i < out.chartHistory.length; i++) {
      expect(out.chartHistory[i].t).toBeGreaterThan(out.chartHistory[i - 1].t);
    }
  });

  it('leaves the stored arrays untouched', () => {
    boundInitHistory(chart, ai);
    expect(chart).toHaveLength(300_000);
    expect(ai).toHaveLength(300_000);
  });
});

describe('boundInitHistory with oversized points', () => {
  it('halves the budgets until the bytes fit, still keeping the newest point', () => {
    const fat = chartPoints(50_000).map((p) => ({ ...p, pad: 'x'.repeat(1000) }));
    const out = boundInitHistory(fat, []);
    expect(bytes(out)).toBeLessThanOrEqual(INIT_HISTORY_MAX_BYTES);
    expect(out.chartHistory.length).toBeLessThan(INIT_CHART_MAX_POINTS);
    expect(out.chartHistory.at(-1)).toBe(fat.at(-1));
  });

  it('terminates with one newest point each when even one point is over budget', () => {
    const chart = chartPoints(100);
    const ai = aiPoints(100);
    const out = boundInitHistory(chart, ai, 10);
    expect(out.chartHistory).toEqual([chart.at(-1)]);
    expect(out.aiChartHistory).toEqual([ai.at(-1)]);
  });
});

/**
 * The wiring: a real `WebSocketTransport` over a fake store holding a full history. The
 * first frame a client gets is `init`, and its size on the wire is what `bufferedAmount`
 * counts against `MAX_BACKLOG`. The client lifts ws's 100 MiB `maxPayload` so that an
 * unbounded `init` arrives and fails an assertion, rather than a socket error.
 */
describe('the init frame a fresh client receives', () => {
  const chart = chartPoints(300_000);
  const ai = aiPoints(300_000);
  // The store's own caps (state-store.ts): 50,000 events, 50,000 layer times (ELEG-199).
  const events = Array.from({ length: 50_000 }, (_, i) => ({
    ts: 1_700_000_000_000 + i * 1000,
    event: {
      type: 'print_progress',
      filename: 'a_rather_long_model_name_plate_v12_final.gcode',
      progress: i % 100,
      layer: i,
      totalLayers: 50_000,
      remaining: 3600,
    },
  }));
  const layers = Array.from({ length: 50_000 }, (_, i) => ({
    layer: i + 1,
    duration: 21.5,
    timestamp: 1_700_000_000_000 + i * 21_500,
  }));
  const bridge = Object.assign(new EventEmitter(), {
    isConnected: true,
    brokerConnected: true,
    phase: 'registered',
    registerAttempts: 1,
    serialNumber: 'TESTSN',
    ip: '192.0.2.10',
    sendCommand: () => {},
  });
  const store = Object.assign(new EventEmitter(), {
    attributes: {},
    status: {},
    canvas: {},
    files: [],
    thumbnail: null,
    thumbnailFailed: false,
    fileTotalLayers: 0,
    timelapseList: [],
    timelapseUrl: null,
    zones: null,
    layerTimes: layers,
    getFilamentUsageArray: () => [],
    getChartHistory: () => chart,
    getAIChartHistory: () => ai,
    getEventLog: () => events,
  });
  let server: Server;
  let transport: WebSocketTransport;
  let port: number;

  beforeAll(async () => {
    server = createServer();
    transport = new WebSocketTransport(
      server,
      store as unknown as StateStore,
      bridge as unknown as MqttBridge,
      { serviceApiKey: '', cameraEnabled: false },
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    transport.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('stays far below MAX_BACKLOG and carries the newest points', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { maxPayload: 0 });
    const raw = await new Promise<Buffer>((resolve, reject) => {
      ws.once('message', (data) => resolve(data as Buffer));
      ws.once('error', reject);
    });
    ws.terminate();
    const init = JSON.parse(raw.toString()) as {
      type: string;
      chartHistory: ChartPoint[];
      aiChartHistory: AIChartPoint[];
      eventLog: typeof events;
      layerTimes: typeof layers;
    };
    expect(init.type).toBe('init');
    expect(raw.byteLength).toBeLessThan(MAX_BACKLOG / 2);
    // The stated bound for the whole frame (ELEG-199): the 8 MiB history budget plus 1 MiB
    // for everything else, with 50,000 events and 50,000 layer times in the store.
    expect(raw.byteLength).toBeLessThan(INIT_HISTORY_MAX_BYTES + 1024 * 1024);
    // eventLog: the browser keeps 100 (ui/event-log.ts MAX_ENTRIES); newest, in order.
    expect(init.eventLog.length).toBeLessThanOrEqual(INIT_EVENT_LOG_MAX_ENTRIES);
    expect(init.eventLog).toEqual(events.slice(-init.eventLog.length));
    expect(init.eventLog.at(-1)).toEqual(events.at(-1));
    // layerTimes: the browser caps at 2000 (printer-state.ts); newest, in order.
    expect(init.layerTimes.length).toBeLessThanOrEqual(INIT_LAYER_TIMES_MAX_ENTRIES);
    expect(init.layerTimes).toEqual(layers.slice(-init.layerTimes.length));
    expect(init.layerTimes.at(-1)).toEqual(layers.at(-1));
    // The store itself is never trimmed.
    expect(events).toHaveLength(50_000);
    expect(layers).toHaveLength(50_000);
    expect(init.chartHistory.length).toBeLessThanOrEqual(INIT_CHART_MAX_POINTS);
    expect(init.chartHistory.at(-1)).toEqual(chart.at(-1));
    expect(init.aiChartHistory.at(-1)).toEqual(ai.at(-1));
  }, 30_000);
});

describe('boundTail', () => {
  it('passes a list that fits through unchanged', () => {
    const small = [1, 2, 3];
    expect(boundTail(small, 3)).toBe(small);
  });

  it('keeps the newest entries in order and leaves the input alone', () => {
    const all = Array.from({ length: 10 }, (_, i) => i);
    expect(boundTail(all, 4)).toEqual([6, 7, 8, 9]);
    expect(all).toHaveLength(10);
  });

  it('never returns an empty tail for a non-empty list', () => {
    expect(boundTail([1, 2, 3], 0)).toEqual([3]);
  });
});

describe('boundHistory', () => {
  it('passes a history that fits through unchanged', () => {
    const small = chartPoints(500);
    expect(boundHistory(small, INIT_CHART_MAX_POINTS, INIT_CHART_FULL_RES_POINTS)).toBe(small);
    expect(boundInitHistory(small, aiPoints(10))).toEqual({
      chartHistory: small,
      aiChartHistory: aiPoints(10),
    });
  });

  it('is exactly the budget, oldest and newest kept, in order', () => {
    const pts = Array.from({ length: 1000 }, (_, i) => i);
    const out = boundHistory(pts, 100, 40);
    expect(out).toHaveLength(100);
    expect(out[0]).toBe(0);
    expect(out.slice(-40)).toEqual(pts.slice(-40));
    expect([...out].sort((a, b) => a - b)).toEqual(out);
    expect(new Set(out).size).toBe(100);
  });
});
