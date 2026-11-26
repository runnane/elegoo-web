/**
 * ELEG-176: the bridge backstop. `MqttBridge.setCommandGuard` is the last check before a
 * publish, for a surface that forgot to ask the print guard itself. Proven through the
 * injectable `connectFn` (as `printer-switch.test.ts` does): the fake client's `publish`
 * is the spy, so "never published" means never on the wire. No broker, no printer.
 */
import { EventEmitter } from 'events';
import type mqtt from 'mqtt';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MqttBridge, type MqttConnectFn } from '../mqtt-bridge.js';
import { printBusyRefusal } from '../print-guard.js';
import type { PrinterStatus } from '../../types.js';

const bridges: MqttBridge[] = [];
afterEach(() => {
  for (const b of bridges.splice(0)) b.disconnect();
});

function connectedBridge() {
  const publish = vi.fn();
  const connectFn: MqttConnectFn = () => {
    const client = new EventEmitter() as EventEmitter & Record<string, unknown>;
    client.subscribe = () => client;
    client.unsubscribe = () => client;
    client.publish = publish;
    client.end = () => client;
    return client as unknown as mqtt.MqttClient;
  };
  // A known SN and a created client are all `sendCommand` needs to publish.
  const bridge = new MqttBridge('192.0.2.10', 'pw', 'TESTSN', undefined, connectFn);
  bridges.push(bridge);
  bridge.connect();
  const sent = vi.fn();
  bridge.on('raw', (direction: string) => {
    if (direction === 'sent') sent();
  });
  /** The method numbers that reached `publish`, in order. */
  const published = () =>
    publish.mock.calls.map(
      ([, payload]) => (JSON.parse(payload as string) as { method: number }).method,
    );
  return { bridge, publish, sent, published };
}

/** Wired exactly as `index.ts` wires it, over a status the test controls. */
function guardOver(state: { status: PrinterStatus | null }) {
  return (m: number, p: Record<string, unknown>) => printBusyRefusal(m, p, state.status);
}

const printing = { machine_status: { status: 2 } } as unknown as PrinterStatus;
const idle = { machine_status: { status: 1 } } as unknown as PrinterStatus;

describe('MqttBridge.setCommandGuard', () => {
  it('drops a refused command: never published, no raw "sent" event', () => {
    const { bridge, publish, sent } = connectedBridge();
    bridge.setCommandGuard(guardOver({ status: printing }));
    bridge.sendCommand(1026, { homed_axes: 'xyz' });
    bridge.sendCommand(1028, { heater_bed: 0 });
    expect(publish).not.toHaveBeenCalled();
    expect(sent).not.toHaveBeenCalled();
  });

  it('still publishes an allowed command while printing (pause, a safe target change)', () => {
    const { bridge, sent, published } = connectedBridge();
    bridge.setCommandGuard(guardOver({ status: printing }));
    bridge.sendCommand(1021, {});
    bridge.sendCommand(1028, { heater_bed: 60 });
    expect(published()).toEqual([1021, 1028]);
    expect(sent).toHaveBeenCalledTimes(2);
  });

  it('idle control: the same refused commands are published when idle', () => {
    const { bridge, published } = connectedBridge();
    bridge.setCommandGuard(guardOver({ status: idle }));
    bridge.sendCommand(1026, { homed_axes: 'xyz' });
    bridge.sendCommand(1028, { heater_bed: 0 });
    expect(published()).toEqual([1026, 1028]);
  });

  it('follows the live status, not the status at wiring time', () => {
    const { bridge, published } = connectedBridge();
    const state = { status: idle as PrinterStatus | null };
    bridge.setCommandGuard(guardOver(state));
    bridge.sendCommand(1027, { axes: 'x', distance: 1 });
    state.status = printing;
    bridge.sendCommand(1027, { axes: 'x', distance: 1 });
    expect(published()).toEqual([1027]);
  });

  it('with no guard installed, everything is published (a test or a tool that never wires one)', () => {
    const { bridge, published } = connectedBridge();
    bridge.sendCommand(1026, {});
    expect(published()).toEqual([1026]);
  });
});
