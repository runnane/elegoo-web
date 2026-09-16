/**
 * Switching the one active printer (ELEG-95).
 *
 * Three claims, each pinned where it lives:
 *
 * 1. `MqttBridge.retarget` closes the client to printer A **before** it creates the one
 *    to printer B, so there is never a moment with two clients alive — AGENTS.md's
 *    one-connection rule. Proven with a fake `connectFn` that counts open clients; no
 *    socket is opened.
 * 2. After `switchActivePrinter`, the store exposes nothing of printer A — and, the
 *    subtle half, B's first status *delta* is not deep-merged into A's leftover status.
 * 3. `state.json` written for A is never restored while the service points at B.
 *
 * Addresses are TEST-NET (RFC 5737).
 */

import { EventEmitter } from 'events';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type mqtt from 'mqtt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConnectionPresets,
  ENV_PRESET_ID,
  PresetError,
  switchActivePrinter,
  VENDOR_DEFAULT_PASSWORD,
} from '../connection-presets.js';
import { MqttBridge, type MqttConnectFn } from '../mqtt-bridge.js';
import { StatePersistence } from '../state-persistence.js';
import { StateStore } from '../state-store.js';

const A = '192.0.2.10';
const B = '198.51.100.20';
const ENV_PASSWORD = `env-secret-${Math.random().toString(36).slice(2)}`;

let dir: string;
const stores: StateStore[] = [];
const bridges: MqttBridge[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'printer-switch-'));
});
afterEach(() => {
  vi.useRealTimers();
  for (const s of stores.splice(0)) s.destroy();
  for (const b of bridges.splice(0)) b.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

// ── 1. the bridge ───────────────────────────────────────────────────────────

function fakeTransport() {
  const log: string[] = [];
  const clients: EventEmitter[] = [];
  let open = 0;
  let maxOpen = 0;
  const connectFn: MqttConnectFn = (url) => {
    const client = new EventEmitter() as EventEmitter & Record<string, unknown>;
    let ended = false;
    client.subscribe = () => client;
    client.unsubscribe = () => client;
    client.publish = () => client;
    client.end = () => {
      if (!ended) {
        ended = true;
        open--;
        log.push(`end ${url}`);
      }
      return client;
    };
    open++;
    maxOpen = Math.max(maxOpen, open);
    log.push(`connect ${url}`);
    clients.push(client);
    return client as unknown as mqtt.MqttClient;
  };
  return {
    connectFn,
    log,
    clients,
    get open() {
      return open;
    },
    get maxOpen() {
      return maxOpen;
    },
  };
}

function makeBridge(t: ReturnType<typeof fakeTransport>): MqttBridge {
  const bridge = new MqttBridge(A, 'pw-a', '', undefined, t.connectFn);
  bridges.push(bridge);
  return bridge;
}

describe('MqttBridge.retarget', () => {
  it('closes the connection to A before it opens one to B, never holding two', () => {
    const t = fakeTransport();
    const bridge = makeBridge(t);
    bridge.connect();

    bridge.retarget({ ip: B, password: 'pw-b', sn: '' });

    expect(t.log).toEqual([
      `connect mqtt://${A}:1883`,
      `end mqtt://${A}:1883`,
      `connect mqtt://${B}:1883`,
    ]);
    expect(t.maxOpen).toBe(1);
    expect(t.open).toBe(1);
    expect(bridge.ip).toBe(B);
  });

  it("does not let a late close from A reset B's connection state", () => {
    const t = fakeTransport();
    const bridge = makeBridge(t);
    bridge.connect();
    bridge.retarget({ ip: B, password: 'pw-b', sn: '' });

    t.clients[1].emit('connect');
    expect(bridge.brokerConnected).toBe(true);
    t.clients[0].emit('close');
    expect(bridge.brokerConnected).toBe(true);
  });

  it('survives the discarded client emitting error after it was ended', () => {
    // mqtt.js keeps a connack timer on a client ended while CONNECTING and fires
    // `connack timeout` ~30s later. With no listener left, EventEmitter throws and the
    // process exits — which the receiver check for ELEG-95 hit on its second switch.
    const t = fakeTransport();
    const bridge = makeBridge(t);
    bridge.connect();
    bridge.retarget({ ip: B, password: 'pw-b', sn: '' });

    expect(() => t.clients[0].emit('error', new Error('connack timeout'))).not.toThrow();
  });

  it('cancels a pending heartbeat reconnect so it cannot open a second client', () => {
    vi.useFakeTimers();
    const t = fakeTransport();
    const bridge = makeBridge(t);
    bridge.connect();
    // What a heartbeat timeout does: end the client, schedule connect() in 5s.
    (bridge as unknown as { reconnect(): void }).reconnect();

    bridge.retarget({ ip: B, password: 'pw-b', sn: '' });
    vi.advanceTimersByTime(10_000);

    expect(t.log.filter((l) => l.startsWith('connect'))).toEqual([
      `connect mqtt://${A}:1883`,
      `connect mqtt://${B}:1883`,
    ]);
    expect(t.open).toBe(1);
  });

  it('announces the old connection going away only if it was up', () => {
    const t = fakeTransport();
    const bridge = makeBridge(t);
    const disconnected = vi.fn();
    bridge.on('disconnected', disconnected);

    bridge.connect();
    bridge.retarget({ ip: B, password: 'pw-b', sn: '' });
    expect(disconnected).not.toHaveBeenCalled();

    t.clients[1].emit('connect');
    bridge.retarget({ ip: A, password: 'pw-a', sn: '' });
    expect(disconnected).toHaveBeenCalledTimes(1);
  });
});

// ── 2. switching and the store ──────────────────────────────────────────────

class StubBridge extends EventEmitter {
  isConnected = true;
  retargets: Array<{ ip: string; password: string; sn: string }> = [];
  retarget(t: { ip: string; password: string; sn: string }): void {
    this.retargets.push({ ip: t.ip, password: t.password, sn: t.sn });
  }
  sendCommand(): void {}
}

function setup() {
  const bridge = new StubBridge();
  const store = new StateStore(bridge as unknown as MqttBridge, 25);
  stores.push(store);
  const presets = new ConnectionPresets(
    { ip: A, password: ENV_PASSWORD, sn: '', cameraUrl: `http://${A}:8080` },
    join(dir, 'connection-presets.json'),
  );
  const b = presets.add({ name: 'Printer B', ip: B });
  return { bridge, store, presets, b, deps: { presets, bridge, store } };
}

/** Everything printer A would leave in the store. */
function feedPrinterA(bridge: StubBridge, store: StateStore, machineStatus = 1): void {
  bridge.emit('connected', 'AAAA0000');
  bridge.emit('response', 1001, { result: { hostname: 'printer-a', sn: 'AAAA0000' } });
  bridge.emit('response', 1002, {
    result: {
      machine_status: { status: machineStatus, sub_status: 0, exception_status: [], progress: 0 },
      extruder: { temperature: 215, target: 215 },
    },
  });
  store.restoreChartData([{ t: Date.now(), values: { nozzle: 215 } }]);
  store.restoreLayerData(
    [
      { layer: 1, duration: 30, timestamp: 1 },
      { layer: 2, duration: 31, timestamp: 2 },
    ],
    3,
    3,
  );
}

describe('switchActivePrinter', () => {
  it("leaves nothing of printer A's state in the store", () => {
    const { bridge, store, b, deps } = setup();
    feedPrinterA(bridge, store);
    // Arrange sanity: A's state really is there to be cleared.
    expect(store.status?.extruder?.temperature).toBe(215);
    expect(store.getEventLog().length).toBeGreaterThan(0);

    expect(switchActivePrinter(deps, b.id).changed).toBe(true);

    expect(store.status).toBeNull();
    expect(store.attributes).toBeNull();
    expect(store.getChartHistory()).toEqual([]);
    expect(store.layerTimes).toEqual([]);
    expect(store.getEventLog()).toEqual([]);
  });

  it("does not merge B's first delta into A's leftover status", () => {
    const { bridge, store, b, deps } = setup();
    feedPrinterA(bridge, store);
    switchActivePrinter(deps, b.id);

    bridge.emit('status', { result: { heater_bed: { temperature: 60, target: 60 } } });

    expect(store.status).toEqual({ heater_bed: { temperature: 60, target: 60 } });
  });

  it("retargets the one bridge with B's credentials, never PRINTER_PASSWORD", () => {
    const { bridge, b, deps, presets } = setup();
    switchActivePrinter(deps, b.id);
    expect(bridge.retargets).toEqual([{ ip: B, password: VENDOR_DEFAULT_PASSWORD, sn: '' }]);
    expect(JSON.stringify(bridge.retargets)).not.toContain(ENV_PASSWORD);
    expect(presets.active().ip).toBe(B);
  });

  it('refuses while the connected printer is printing, and changes nothing', () => {
    const { bridge, store, b, deps, presets } = setup();
    feedPrinterA(bridge, store, 2);

    const attempt = () => switchActivePrinter(deps, b.id);
    expect(attempt).toThrow(PresetError);
    expect(attempt).toThrow(/printing/);
    expect(bridge.retargets).toEqual([]);
    expect(presets.active().id).toBe(ENV_PRESET_ID);
    expect(store.status).not.toBeNull();
  });

  it('never blocks switching away from a printer that is not connected', () => {
    const { bridge, store, b, deps } = setup();
    feedPrinterA(bridge, store, 2);
    bridge.isConnected = false;
    expect(switchActivePrinter(deps, b.id).changed).toBe(true);
  });

  it('is a no-op for the printer already active, and a 404 for an unknown one', () => {
    const { bridge, deps } = setup();
    expect(switchActivePrinter(deps, ENV_PRESET_ID).changed).toBe(false);
    expect(bridge.retargets).toEqual([]);
    expect(() => switchActivePrinter(deps, 'nope')).toThrow(PresetError);
  });

  it('remembers the active printer across a restart', () => {
    const { b, deps } = setup();
    switchActivePrinter(deps, b.id);
    const reloaded = new ConnectionPresets(
      { ip: A, password: ENV_PASSWORD, sn: '', cameraUrl: `http://${A}:8080` },
      join(dir, 'connection-presets.json'),
    );
    expect(reloaded.active().ip).toBe(B);
  });

  it('calls afterSwitch with the new active preset — the seam the print queue resets through (ELEG-107)', () => {
    const { b, deps } = setup();
    const afterSwitch = vi.fn();

    switchActivePrinter({ ...deps, afterSwitch }, b.id);

    expect(afterSwitch).toHaveBeenCalledTimes(1);
    expect(afterSwitch).toHaveBeenCalledWith(expect.objectContaining({ id: b.id, ip: B }));
  });

  it('never calls afterSwitch for the no-op of switching to the already-active printer', () => {
    const { deps } = setup();
    const afterSwitch = vi.fn();

    switchActivePrinter({ ...deps, afterSwitch }, ENV_PRESET_ID);

    expect(afterSwitch).not.toHaveBeenCalled();
  });
});

// ── 3. state.json ───────────────────────────────────────────────────────────

function bareStore(): StateStore {
  const store = new StateStore(new EventEmitter() as unknown as MqttBridge, 25);
  stores.push(store);
  return store;
}

describe('StatePersistence and the active printer', () => {
  it("never restores printer A's snapshot while pointed at printer B", async () => {
    let current = A;
    const printer = { current: () => current, legacy: A };
    const saved = bareStore();
    saved.restoreChartData([{ t: Date.now(), values: { nozzle: 215 } }]);
    await new StatePersistence(saved, dir, printer).saveNow();

    current = B;
    const onB = bareStore();
    expect(await new StatePersistence(onB, dir, printer).load()).toBe(false);
    expect(onB.getChartHistory()).toEqual([]);

    current = A;
    const onA = bareStore();
    expect(await new StatePersistence(onA, dir, printer).load()).toBe(true);
    expect(onA.getChartHistory()).toHaveLength(1);
  });

  it('treats a state.json from before presets as the PRINTER_IP printer', async () => {
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        version: 4,
        savedAt: Date.now(),
        chartData: [{ t: Date.now(), values: { nozzle: 200 } }],
        layerTimes: [],
        lastLayer: 0,
        lastLayerTime: 0,
      }),
      'utf-8',
    );
    const legacyOnEnv = new StatePersistence(bareStore(), dir, { current: () => A, legacy: A });
    expect(await legacyOnEnv.load()).toBe(true);
    const legacyOnB = new StatePersistence(bareStore(), dir, { current: () => B, legacy: A });
    expect(await legacyOnB.load()).toBe(false);
  });
});
