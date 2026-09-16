/**
 * OTA firmware-update progress for Telegram (ELEG-104), read-only.
 *
 * Nothing here stands up a bot — like the allowlist test, the grammy wiring is verified
 * by reading. What is pinned is the decision that wiring defers to: which
 * `sub_status_change` events produce a message at all (`classifyOtaTransition`), and
 * what the message says (`formatEvent`, the same function the bot calls — an empty
 * `text` is how it declines to send).
 *
 * Every code sequence below is generated. No printer, no MQTT, no OTA method: the
 * events are the shape `StateStore.detectEvents` emits, hand-built.
 */

import { EventEmitter } from 'events';
import { afterEach, describe, expect, it } from 'vitest';
import type { MqttBridge } from '../mqtt-bridge.js';
import { classifyOtaTransition, otaDisplayMessage, otaPhaseName } from '../ota-status.js';
import { type PrintEvent, StateStore } from '../state-store.js';
import { formatEvent } from '../telegram.js';
import { SUB_STATUS_NAMES } from '../../types.js';

const name = (code: number) => SUB_STATUS_NAMES[code] ?? `Unknown (${code})`;

function subStatusEvent(fromCode: number, toCode: number): PrintEvent {
  return { type: 'sub_status_change', fromCode, toCode, from: name(fromCode), to: name(toCode) };
}

/** Walk a sub_status sequence the way the store would emit it, collecting every message. */
function notificationsFor(codes: number[]): string[] {
  const sent: string[] = [];
  for (let i = 1; i < codes.length; i++) {
    const { text } = formatEvent(subStatusEvent(codes[i - 1], codes[i]));
    if (text) sent.push(text);
  }
  return sent;
}

describe('classifyOtaTransition — which sub_status changes are worth a message', () => {
  it('entering an in-progress phase from a non-OTA state is "entered", for every entry code', () => {
    for (const code of [2601, 2701, 2702, 2703]) {
      expect(classifyOtaTransition(0, code), `0 → ${code}`).toBe('entered');
      expect(classifyOtaTransition(-1, code), `-1 → ${code}`).toBe('entered');
    }
  });

  it('the hop between in-progress phases is silent', () => {
    expect(classifyOtaTransition(2601, 2701)).toBeNull();
    expect(classifyOtaTransition(2701, 2702)).toBeNull();
    expect(classifyOtaTransition(2702, 2703)).toBeNull();
  });

  it('2704 is "completed" and 2705 is "failed", whichever phase preceded them', () => {
    expect(classifyOtaTransition(2703, 2704)).toBe('completed');
    expect(classifyOtaTransition(2701, 2705)).toBe('failed');
    // A service start whose baseline already sits at the terminal code.
    expect(classifyOtaTransition(-1, 2704)).toBe('completed');
    expect(classifyOtaTransition(-1, 2705)).toBe('failed');
  });

  it('leaving a terminal code is silent — that update was already reported', () => {
    expect(classifyOtaTransition(2704, 0)).toBeNull();
    expect(classifyOtaTransition(2705, 0)).toBeNull();
  });

  it('leaving an in-progress phase without a terminal code is "ended"', () => {
    expect(classifyOtaTransition(2703, 0)).toBe('ended');
    expect(classifyOtaTransition(2701, 2603)).toBe('ended');
  });

  it('anything that never touches an OTA code is null', () => {
    expect(classifyOtaTransition(0, 2502)).toBeNull();
    expect(classifyOtaTransition(2502, 0)).toBeNull();
    expect(classifyOtaTransition(1061, 1062)).toBeNull();
  });
});

describe('formatEvent — Telegram wording for an OTA transition', () => {
  it('a full successful update (idle → 2701 → 2702 → 2703 → 2704 → idle) sends exactly two messages', () => {
    const sent = notificationsFor([0, 2701, 2702, 2703, 2704, 0]);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain('Firmware update in progress');
    expect(sent[0]).toContain('do not power off the printer');
    expect(sent[0]).toContain('Downloading');
    expect(sent[1]).toContain('Firmware update complete');
    expect(sent[1]).toContain('restart on its own');
  });

  it('an update that fails (idle → 2701 → 2705 → idle) sends the warning and then the failure', () => {
    const sent = notificationsFor([0, 2701, 2705, 0]);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain('do not power off the printer');
    expect(sent[1]).toContain('Firmware update failed');
    expect(sent[1]).toContain('Downloading');
  });

  it('the 2701 → 2702 hop alone sends nothing', () => {
    expect(formatEvent(subStatusEvent(2701, 2702)).text).toBe('');
    expect(notificationsFor([2701, 2702, 2703])).toEqual([]);
  });

  it('leaving an in-progress phase without a terminal code sends the neutral "ended" message', () => {
    const { text, urgent } = formatEvent(subStatusEvent(2703, 0));
    expect(text).toContain('Firmware update ended');
    expect(urgent).toBe(false);
  });

  it('a non-OTA sub_status change still sends nothing, as before this feature', () => {
    expect(formatEvent(subStatusEvent(0, 2502)).text).toBe('');
    expect(formatEvent(subStatusEvent(1061, 1062)).text).toBe('');
  });

  it('the warning is urgent (audible), the completion is not', () => {
    expect(formatEvent(subStatusEvent(0, 2703)).urgent).toBe(true);
    expect(formatEvent(subStatusEvent(2703, 2704)).urgent).toBe(false);
    expect(formatEvent(subStatusEvent(2703, 2705)).urgent).toBe(true);
  });

  it('the text is valid MarkdownV2 — the reserved characters it carries are escaped', () => {
    // '.' and '(' ')' are reserved in MarkdownV2; an unescaped one makes Telegram reject
    // the whole message with a 400, which is a silent no-notification in production.
    for (const codes of [
      [0, 2701],
      [2703, 2704],
      [2703, 2705],
      [2703, 0],
    ] as const) {
      const { text } = formatEvent(subStatusEvent(codes[0], codes[1]));
      const unescaped = text.replace(/\\[_*[\]()~`>#+\-=|{}.!\\]/g, '');
      expect(unescaped, text).not.toMatch(/[.!()]/);
    }
  });
});

describe('otaPhaseName / otaDisplayMessage — the Moonraker banner text', () => {
  it('drops the redundant "OTA " prefix from the sub-status name', () => {
    expect(otaPhaseName(2701)).toBe('Downloading');
    expect(otaPhaseName(2703)).toBe('Updating');
    expect(otaPhaseName(2601)).toBe('Info Updating');
  });

  it('says "do not power off" and names the phase for every in-progress code', () => {
    for (const code of [2601, 2701, 2702, 2703]) {
      const msg = otaDisplayMessage(code);
      expect(msg, `code ${code}`).toContain('do not power off the printer');
      expect(msg, `code ${code}`).toContain(otaPhaseName(code));
    }
  });

  it('gives the two terminal codes their own calmer text', () => {
    expect(otaDisplayMessage(2704)).toContain('Firmware update complete');
    expect(otaDisplayMessage(2705)).toBe('Firmware update failed');
  });

  it('is empty for every non-OTA sub_status, so the banner clears on its own', () => {
    expect(otaDisplayMessage(0)).toBe('');
    expect(otaDisplayMessage(2502)).toBe('');
    expect(otaDisplayMessage(2603)).toBe('');
    expect(otaDisplayMessage(undefined)).toBe('');
    expect(otaDisplayMessage(null)).toBe('');
  });
});

/**
 * The one store-side change: a service (re)start whose first full status already sits
 * in an OTA sub-status. `establishBaseline` seeds `lastSubStatus` with that code, so
 * `detectEvents` would never see the transition into it — and Telegram would never say
 * "do not power off" to whoever restarted the service mid-flash. The baseline now
 * synthesises that one transition, the way it already re-announces a print in progress.
 */
describe('StateStore baseline — a service start that lands inside a firmware update', () => {
  let store: StateStore | null = null;
  afterEach(() => {
    store?.destroy();
    store = null;
  });

  function fullStatus(subStatus: number) {
    return {
      result: {
        machine_status: { status: 1, sub_status: subStatus, exception_status: [], progress: 0 },
      },
    };
  }

  function boot(subStatus: number): { bridge: EventEmitter; events: PrintEvent[] } {
    const bridge = new EventEmitter();
    store = new StateStore(bridge as unknown as MqttBridge, 25);
    const events: PrintEvent[] = [];
    store.on('print_event', (e: PrintEvent) => events.push(e));
    bridge.emit('connected', 'FIXT0000');
    bridge.emit('response', 1002, fullStatus(subStatus));
    return { bridge, events };
  }

  it('emits one sub_status_change into the OTA code, which Telegram reads as "entered"', () => {
    const { events } = boot(2703);
    const subs = events.filter((e) => e.type === 'sub_status_change');
    expect(subs).toHaveLength(1);
    const e = subs[0] as Extract<PrintEvent, { type: 'sub_status_change' }>;
    expect(e.toCode).toBe(2703);
    expect(e.to).toBe('OTA Updating');
    expect(classifyOtaTransition(e.fromCode, e.toCode)).toBe('entered');
    expect(formatEvent(e).text).toContain('do not power off the printer');
  });

  it('emits nothing extra when the baseline is an ordinary idle status', () => {
    const { events } = boot(0);
    expect(events.filter((e) => e.type === 'sub_status_change')).toHaveLength(0);
  });

  it('still reports the exit once the printer comes back from its reboot', () => {
    const { bridge, events } = boot(2703);
    // The printer reboots after flashing and its next full status is plain idle.
    bridge.emit('response', 1002, fullStatus(0));
    const subs = events.filter(
      (e): e is Extract<PrintEvent, { type: 'sub_status_change' }> =>
        e.type === 'sub_status_change',
    );
    expect(subs.map((e) => [e.fromCode, e.toCode])).toEqual([
      [-1, 2703],
      [2703, 0],
    ]);
    expect(formatEvent(subs[1]).text).toContain('Firmware update ended');
  });
});
