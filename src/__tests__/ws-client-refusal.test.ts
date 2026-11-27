// @vitest-environment jsdom
/**
 * ELEG-176: a `command_refused` frame toasts the right explanation. Before this, every
 * refusal toasted the API-key message, which would tell a user mid-print to go and enter a
 * key. The real `WsClient` is driven through a stand-in WebSocket; `toast` is the spy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../ui/toast', () => ({ toast: vi.fn() }));

import { NEEDS_API_KEY_MESSAGE } from '../ui/api-key';
import { toast } from '../ui/toast';
import { WsClient } from '../ws-client';

/** Just enough of a browser WebSocket for `WsClient.connect` to attach its handlers. */
class FakeSocket {
  static last: FakeSocket | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readyState = 1;
  send = vi.fn();
  close = vi.fn();
  constructor() {
    FakeSocket.last = this;
  }
}

function deliver(frame: Record<string, unknown>): void {
  FakeSocket.last?.onmessage?.({ data: JSON.stringify(frame) });
}

function connectClient(): WsClient {
  const client = new WsClient({
    serviceUrl: 'ws://192.0.2.1/ws',
    onStateChange: () => {},
    onRegistered: () => {},
    onMessage: () => {},
    onStatusEvent: () => {},
  });
  client.connect();
  return client;
}

const BUSY_REASON =
  'Printer is busy printing — homing is refused while a job is active. ' +
  'Pause/stop/e-stop stay available; retry once the printer is idle.';

beforeEach(() => {
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.mocked(toast).mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('command_refused', () => {
  it('code "busy" toasts the server\'s reason, not the API-key message', () => {
    connectClient();
    deliver({ type: 'command_refused', method: 1026, code: 'busy', reason: BUSY_REASON });
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(BUSY_REASON, 'error');
    expect(toast).not.toHaveBeenCalledWith(NEEDS_API_KEY_MESSAGE, 'error');
  });

  it('code "auth" still toasts the API-key message', () => {
    connectClient();
    deliver({ type: 'command_refused', method: 1026, code: 'auth', reason: 'API key required' });
    expect(toast).toHaveBeenCalledWith(NEEDS_API_KEY_MESSAGE, 'error');
  });

  it('no code at all (an older server) still toasts the API-key message', () => {
    connectClient();
    deliver({ type: 'command_refused', method: 1026, reason: 'API key required' });
    expect(toast).toHaveBeenCalledWith(NEEDS_API_KEY_MESSAGE, 'error');
  });

  it('a silent auth refusal (2006) stays silent', () => {
    connectClient();
    deliver({ type: 'command_refused', method: 2006, code: 'auth', reason: 'API key required' });
    expect(toast).not.toHaveBeenCalled();
  });
});
