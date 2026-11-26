// @vitest-environment jsdom
/**
 * ELEG-163 — the controls that can ruin a running job are locked while it runs.
 *
 * `bindControls` is the real `controls.ts` implementation, not a stand-in, so a locked
 * button is proven not to reach `sendCommand` through the same click handler a person
 * would hit. No printer is involved: the client is a spy and the state is synthetic.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { bindControls, HOME_CONFIRM, onCommandResponse } from '../ui/controls';
import { applyPrintLock, isJobActive, PRINT_LOCK_REASON } from '../ui/print-lock';
import type { PrinterStatus } from '../types';
import type { CommandSender } from '../ws-client';

const sendCommand = vi.fn();
const client: CommandSender = { sendCommand, printerIp: '192.0.2.1' };

function status(code: number): PrinterStatus {
  return { machine_status: { status: code } } as unknown as PrinterStatus;
}

function btn(id: string): HTMLButtonElement {
  return document.getElementById(id) as HTMLButtonElement;
}

function mount(): void {
  document.body.innerHTML = `
    <button id="btn-pause">Pause</button>
    <button id="btn-resume">Resume</button>
    <button id="btn-stop">Stop</button>
    <button id="btn-estop">E-stop</button>
    <input id="set-nozzle-temp" type="number" value="210">
    <button id="btn-set-nozzle">Set</button>
    <button id="btn-off-nozzle">Off</button>
    <input id="set-bed-temp" type="number" value="60">
    <button id="btn-set-bed">Set</button>
    <button id="btn-off-bed">Off</button>
    <button class="temp-preset-btn" id="preset-cool" data-nozzle="0" data-bed="0">Cool</button>
    <button class="move-btn" id="jog-xp" data-axis="x" data-dir="1">X+</button>
    <button class="move-btn home-btn" id="btn-home-all" title="Home All Axes">H</button>
    <button class="move-btn home-btn" id="btn-home-all-z" title="Home All Axes">H</button>
    <button class="dist-btn" data-dist="10">10mm</button>
    <button class="speed-btn" id="speed-balanced" data-mode="1">Balanced</button>
    <input id="fan-model-toggle" type="checkbox">
    <input id="fan-aux-toggle" type="checkbox">
    <input id="fan-case-toggle" type="checkbox">
    <input id="led-toggle" type="checkbox">
    <button id="btn-mqtt-capture">Capture</button>
    <div id="canvas-status">
      <button class="spool-load-btn" id="tray-load" data-canvas-id="0" data-tray-id="1">Load</button>
      <button class="spool-unload-btn" id="tray-unload" data-canvas-id="0" data-tray-id="3">Unload</button>
    </div>
  `;
}

const LOCKED = [
  'set-nozzle-temp',
  'btn-set-nozzle',
  'btn-off-nozzle',
  'set-bed-temp',
  'btn-set-bed',
  'btn-off-bed',
  'preset-cool',
  'jog-xp',
  'btn-home-all',
  'btn-home-all-z',
  'tray-load',
  'tray-unload',
];
const LIVE = ['btn-pause', 'btn-resume', 'btn-stop', 'btn-estop', 'speed-balanced', 'led-toggle'];

beforeAll(() => {
  mount();
  bindControls(client);
});

afterEach(() => {
  applyPrintLock(document, false);
  for (const m of [1026, 1027, 1028]) onCommandResponse(m);
  sendCommand.mockClear();
  vi.restoreAllMocks();
});

describe('isJobActive', () => {
  it('is true while printing (2) and while a power-loss job waits (15)', () => {
    expect(isJobActive(status(2))).toBe(true);
    expect(isJobActive(status(15))).toBe(true);
  });
  it('is false when idle, in calibration, or with no status yet', () => {
    expect(isJobActive(status(1))).toBe(false);
    expect(isJobActive(status(5))).toBe(false);
    expect(isJobActive(null)).toBe(false);
  });
});

describe('applyPrintLock', () => {
  it('disables every job-ruining control with a reason, and leaves print/fan/light controls live', () => {
    applyPrintLock(document, isJobActive(status(2)));
    for (const id of LOCKED) {
      expect(btn(id).disabled, id).toBe(true);
      expect(btn(id).title, id).toBe(PRINT_LOCK_REASON);
    }
    for (const id of LIVE) expect(btn(id).disabled, id).toBe(false);
  });

  it('a locked jog, heater-off or tray button sends nothing when clicked', () => {
    applyPrintLock(document, true);
    btn('jog-xp').click();
    btn('btn-off-nozzle').click();
    btn('preset-cool').click();
    btn('btn-home-all').click();
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('a command response arriving mid-print does not re-enable a locked button', () => {
    btn('jog-xp').click(); // idle: the jog goes out and the button waits for its reply
    expect(sendCommand).toHaveBeenCalledWith(1027, { axes: 'x', distance: 10 });
    applyPrintLock(document, true); // the print starts before the reply lands
    onCommandResponse(1027);
    expect(btn('jog-xp').disabled).toBe(true);
  });

  it('unlocking restores the controls and their original titles', () => {
    applyPrintLock(document, true);
    applyPrintLock(document, false);
    for (const id of LOCKED) expect(btn(id).disabled, id).toBe(false);
    expect(btn('btn-home-all').title).toBe('Home All Axes');
    expect(btn('jog-xp').hasAttribute('title')).toBe(false);
  });

  it('locks tray buttons a card re-render created after the last pass', () => {
    applyPrintLock(document, true);
    document.getElementById('canvas-status')!.innerHTML =
      '<button class="spool-load-btn" id="tray-load-2">Load</button>';
    applyPrintLock(document, true);
    expect(btn('tray-load-2').disabled).toBe(true);
  });
});

describe('Home button', () => {
  it('asks before homing, and sends nothing when the question is declined', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    btn('btn-home-all').click();
    expect(confirmSpy).toHaveBeenCalledWith(HOME_CONFIRM);
    expect(sendCommand).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    btn('btn-home-all-z').click();
    expect(sendCommand).toHaveBeenCalledWith(1026, { homed_axes: 'xyz' });
  });
});
