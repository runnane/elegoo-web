// @vitest-environment jsdom
/**
 * ELEG-33 — the DOM half.
 *
 * `keymap.test.ts` covers the pure resolution exhaustively; this file proves the
 * *wiring* actually reaches the real, already-tested confirmation path rather than a
 * stand-in for it. `bindControls` here is the genuine `controls.ts` implementation —
 * not mocked — so `btn-stop`'s confirmation gate and `btn-home-all`'s guardedSend are
 * the real ones a person clicking the button would hit. Both a printer button's DOM id
 * and `keyboard-shortcuts.ts`'s reference to it are strings that could drift apart
 * silently (AGENTS.md's "a string inside a string" trap); this file is what would go
 * red if they did.
 *
 * `bindControls` and `bindKeyboardShortcuts` are both idempotent (module-level `bound`
 * flags), so the fixture is built once in `beforeAll` and every test shares it —
 * matching how the app itself binds exactly once per page load.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { bindControls, onCommandResponse } from '../ui/controls';
import { bindKeyboardShortcuts } from '../ui/keyboard-shortcuts';
import type { CommandSender } from '../ws-client';

function mountLayout(): void {
  document.body.innerHTML = `
    <nav id="main-tabs">
      <button class="main-tab active" data-tab="dashboard">Dashboard</button>
      <button class="main-tab" data-tab="tools">Tools</button>
      <button class="main-tab" data-tab="settings">Settings</button>
      <button class="main-tab" data-tab="debug">Debug</button>
      <button class="main-tab" data-tab="help">Help</button>
    </nav>
    <div id="connect-dialog"></div>
    <div id="dashboard" data-connected="true"></div>
    <div id="settings-tab-content" class="hidden"></div>
    <div id="tools-tab-content" class="hidden"></div>
    <div id="help-tab-content" class="hidden"><div id="help-content"></div></div>
    <div id="debug-tab-content" class="hidden"></div>

    <button id="btn-pause">Pause</button>
    <button id="btn-resume">Resume</button>
    <button id="btn-stop">Stop</button>
    <button id="btn-estop">Emergency Stop</button>
    <button id="btn-set-nozzle">Set</button>
    <button id="btn-off-nozzle">Off</button>
    <button id="btn-set-bed">Set</button>
    <button id="btn-off-bed">Off</button>
    <button id="btn-home-all">Home</button>
    <button id="btn-home-all-z">Home Z</button>
    <input id="fan-model-toggle" type="checkbox">
    <input id="fan-aux-toggle" type="checkbox">
    <input id="fan-case-toggle" type="checkbox">
    <input id="led-toggle" type="checkbox">
    <button id="btn-mqtt-capture">Capture</button>

    <input id="files-filter" placeholder="Filter">
    <img id="camera-feed" alt="">
    <button id="camera-overlay-btn">Overlay</button>
    <div id="camera-modal" class="hidden"></div>
  `;
}

function press(key: string, opts: Partial<KeyboardEventInit> = {}): void {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }),
  );
}

function dialogOpen(): boolean {
  return document.getElementById('confirm-dialog-overlay') !== null;
}

function answer(which: 'confirm' | 'cancel'): void {
  (document.getElementById(`confirm-dialog-${which}`) as HTMLButtonElement).click();
}

/** Let the awaiting click handler continue after the dialog settles. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('keyboard shortcuts — DOM wiring', () => {
  let sendCommand: ReturnType<
    typeof vi.fn<(method: number, params: Record<string, unknown>) => void>
  >;

  beforeAll(() => {
    mountLayout();
    sendCommand = vi.fn<(method: number, params: Record<string, unknown>) => void>();
    const client: CommandSender = { sendCommand, printerIp: '10.0.0.1' };
    bindControls(client); // real click handlers: throttle, in-flight guard, confirmation
    bindKeyboardShortcuts();
  });

  it('switches tabs on the bare number keys', () => {
    press('4');
    expect(document.getElementById('debug-tab-content')?.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('dashboard')?.classList.contains('hidden')).toBe(true);

    press('1');
    expect(document.getElementById('dashboard')?.classList.contains('hidden')).toBe(false);
  });

  it('opens Help on both the "5" tab key and the "?" key', () => {
    press('5');
    expect(document.getElementById('help-tab-content')?.classList.contains('hidden')).toBe(false);
    press('1');
    expect(document.getElementById('dashboard')?.classList.contains('hidden')).toBe(false);

    press('?', { shiftKey: true });
    expect(document.getElementById('help-tab-content')?.classList.contains('hidden')).toBe(false);
    press('1');
  });

  it('focuses the file filter on "f"', () => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    press('f');
    expect(document.activeElement?.id).toBe('files-filter');
    (document.activeElement as HTMLElement).blur();
  });

  it('toggles the camera overlay button state on "c"', () => {
    const btn = document.getElementById('camera-overlay-btn')!;
    const before = btn.classList.contains('active');
    press('c');
    expect(btn.classList.contains('active')).toBe(!before);
  });

  it('bare "p" (no Shift) does not pause the print', () => {
    sendCommand.mockClear();
    press('p');
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('bare "r" (no Shift) does not resume the print', () => {
    sendCommand.mockClear();
    press('r');
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('Shift+P pauses immediately — no confirmation, but Shift is required', () => {
    sendCommand.mockClear();
    press('p', { shiftKey: true });
    expect(sendCommand).toHaveBeenCalledWith(1021, {});
    expect(dialogOpen()).toBe(false);
    onCommandResponse(1021);
  });

  it('Shift+R resumes immediately — no confirmation, but Shift is required', () => {
    sendCommand.mockClear();
    press('r', { shiftKey: true });
    expect(sendCommand).toHaveBeenCalledWith(1023, {});
    expect(dialogOpen()).toBe(false);
    onCommandResponse(1023);
  });

  it('bare "s" (no Shift) does not stop the print', () => {
    sendCommand.mockClear();
    press('s');
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('Shift+S sends nothing until the confirmation is accepted', async () => {
    sendCommand.mockClear();
    press('s', { shiftKey: true });
    expect(dialogOpen()).toBe(true);
    expect(sendCommand).not.toHaveBeenCalled();

    // Cancelling the dialog still sends nothing.
    answer('cancel');
    await flush();
    expect(dialogOpen()).toBe(false);
    expect(sendCommand).not.toHaveBeenCalled();

    press('s', { shiftKey: true });
    expect(sendCommand).not.toHaveBeenCalled();
    answer('confirm');
    await flush();
    expect(sendCommand).toHaveBeenCalledWith(1022, {});

    onCommandResponse(1022);
  });

  it('Escape on the stop confirmation cancels it and sends nothing', async () => {
    sendCommand.mockClear();
    press('s', { shiftKey: true });
    expect(dialogOpen()).toBe(true);
    press('Escape');
    await flush();
    expect(dialogOpen()).toBe(false);
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('a shortcut typed while a confirmation is open does not stack another or send', async () => {
    sendCommand.mockClear();
    press('s', { shiftKey: true });
    expect(dialogOpen()).toBe(true);
    press('h', { shiftKey: true });
    press('p', { shiftKey: true });
    expect(document.querySelectorAll('#confirm-dialog-overlay')).toHaveLength(1);
    expect(sendCommand).not.toHaveBeenCalled();
    answer('cancel');
    await flush();
  });

  it('bare "h" (no Shift) does not home the axes', () => {
    sendCommand.mockClear();
    press('h');
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('Shift+H sends nothing until the confirmation is accepted', async () => {
    sendCommand.mockClear();
    press('h', { shiftKey: true });
    expect(dialogOpen()).toBe(true);
    expect(sendCommand).not.toHaveBeenCalled();
    answer('cancel');
    await flush();
    expect(sendCommand).not.toHaveBeenCalled();

    press('h', { shiftKey: true });
    answer('confirm');
    await flush();
    expect(sendCommand).toHaveBeenCalledWith(1026, { homed_axes: 'xyz' });

    onCommandResponse(1026);
  });

  it('a held (repeated) Shift+S never opens the dialog or re-sends the stop command', () => {
    sendCommand.mockClear();
    press('s', { shiftKey: true, repeat: true });
    expect(dialogOpen()).toBe(false);
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('never fires a printer action while a text input has focus', () => {
    sendCommand.mockClear();
    const filter = document.getElementById('files-filter') as HTMLInputElement;
    filter.focus();

    press('p', { shiftKey: true });
    press('s', { shiftKey: true });

    expect(sendCommand).not.toHaveBeenCalled();
    expect(dialogOpen()).toBe(false);

    filter.blur();
  });

  it('never fires while the camera modal is open', () => {
    sendCommand.mockClear();
    const modal = document.getElementById('camera-modal')!;
    modal.classList.remove('hidden');

    press('s', { shiftKey: true });

    expect(dialogOpen()).toBe(false);
    expect(sendCommand).not.toHaveBeenCalled();

    modal.classList.add('hidden');
  });
});
