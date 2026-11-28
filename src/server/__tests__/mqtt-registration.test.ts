/**
 * ELEG-189 (from PR #158): only the reply to OUR registration counts.
 *
 * `elegoo/#` stays subscribed when the SN is known, so the bridge also hears other
 * clients' `register_response` (the vendor app, Home Assistant, a second instance). Before
 * the fix a foreign success re-ran init and emitted `connected` again, which Telegram
 * announced as another "Printer connected", and a foreign `code: 3` marked us rejected.
 *
 * Driven through the injectable `connectFn`, as `print-guard-bridge.test.ts` does: the
 * fake client's events are the broker, and our request id is read from the registration
 * the bridge actually publishes, not from a private field. No broker, no printer.
 */
import { EventEmitter } from 'events';
import type mqtt from 'mqtt';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MqttBridge, type MqttConnectFn } from '../mqtt-bridge.js';

const SN = 'TESTSN';
const FOREIGN = 'ffffffffffffffffffffffffff';
const bridges: MqttBridge[] = [];
afterEach(() => {
  for (const b of bridges.splice(0)) b.disconnect();
});

function registeredBridge() {
  let client!: EventEmitter;
  const publish = vi.fn();
  const connectFn: MqttConnectFn = () => {
    const c = new EventEmitter() as EventEmitter & Record<string, unknown>;
    c.subscribe = () => c;
    c.unsubscribe = () => c;
    c.publish = publish;
    c.end = () => c;
    client = c;
    return c as unknown as mqtt.MqttClient;
  };
  const bridge = new MqttBridge('192.0.2.10', 'pw', SN, undefined, connectFn);
  bridges.push(bridge);
  bridge.connect();
  client.emit('connect'); // known SN → the bridge registers at once

  const registration = publish.mock.calls.find(([topic]) => topic === `elegoo/${SN}/api_register`);
  expect(registration, 'the bridge published its registration').toBeDefined();
  const requestId = (JSON.parse(registration![1] as string) as { request_id: string }).request_id;
  expect(requestId).toMatch(/^[0-9a-f]{26}$/);
  expect(requestId).not.toBe(FOREIGN);

  const connected = vi.fn();
  bridge.on('connected', connected);
  const reply = (id: string, data: Record<string, unknown>) =>
    client.emit(
      'message',
      `elegoo/${SN}/${id}/register_response`,
      Buffer.from(JSON.stringify(data)),
    );
  return { bridge, client, requestId, connected, reply };
}

describe('MqttBridge registration replies (ELEG-189)', () => {
  it("ignores another client's successful registration", () => {
    const { bridge, connected, reply } = registeredBridge();
    reply(FOREIGN, { error: 'ok' });
    expect(bridge.isConnected).toBe(false);
    expect(connected).not.toHaveBeenCalled();
  });

  it("ignores another client's rejection (code 3)", () => {
    const { bridge, reply } = registeredBridge();
    reply(FOREIGN, { code: 3 });
    expect(bridge.registrationRejected).toBe(false);
  });

  it('accepts our own success exactly once while the session is up', () => {
    const { bridge, connected, requestId, reply } = registeredBridge();
    reply(requestId, { error: 'ok' });
    expect(bridge.isConnected).toBe(true);
    expect(connected).toHaveBeenCalledTimes(1);
    expect(connected).toHaveBeenCalledWith(SN);

    reply(requestId, { error: 'ok' }); // a duplicate reply
    reply(FOREIGN, { error: 'ok' }); // another client registering later
    expect(connected).toHaveBeenCalledTimes(1);
  });

  it('still honours our own rejection', () => {
    const { bridge, requestId, reply } = registeredBridge();
    reply(requestId, { code: 3 });
    expect(bridge.registrationRejected).toBe(true);
  });

  it('announces a genuine reconnection again after a drop', () => {
    const { bridge, client, connected, requestId, reply } = registeredBridge();
    reply(requestId, { error: 'ok' });
    client.emit('close'); // the connection really dropped
    expect(bridge.isConnected).toBe(false);
    reply(requestId, { error: 'ok' });
    expect(bridge.isConnected).toBe(true);
    expect(connected).toHaveBeenCalledTimes(2);
  });
});
