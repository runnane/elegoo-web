/**
 * The print queue's state machine (ELEG-35).
 *
 * No printer and no MQTT: the queue is handed a stub that emits the store's events and a
 * stub bridge that records what would have been sent. So every "start" below is a
 * recorded `sendCommand(1020, …)` call — evidence that a start was *dispatched*, never
 * that a print began. Nothing here can reach a machine.
 *
 * Fixture file names are generated, not taken from a real printer.
 */

import { EventEmitter } from 'events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDataPaths, printQueueFile, resetDataPathsForTest } from '../data-paths.js';
import {
  PrintQueue,
  START_PRINT_METHOD,
  moveItem,
  parsePersistedQueue,
  sanitiseStartConfig,
} from '../print-queue.js';
import type { PrintEvent } from '../state-store.js';
import { BED_CLEAR_REMINDER, QUEUE_MAX_ITEMS, printerActivity } from '../../print-queue-shared.js';

class StubPrinter extends EventEmitter {
  status: { machine_status: { status: number; sub_status: number } } | null = {
    machine_status: { status: 1, sub_status: 0 },
  };
  set(status: number, subStatus = 0): void {
    this.status = { machine_status: { status, sub_status: subStatus } };
  }
  event(event: PrintEvent): void {
    this.emit('print_event', event);
  }
}

class StubBridge {
  calls: Array<{ method: number; params: Record<string, unknown> }> = [];
  sendCommand(method: number, params: Record<string, unknown>): void {
    this.calls.push({ method, params });
  }
  starts() {
    return this.calls.filter((c) => c.method === START_PRINT_METHOD);
  }
}

let dir: string;
let printer: StubPrinter;
let bridge: StubBridge;

function makeQueue(): PrintQueue {
  return new PrintQueue(printer, bridge, printQueueFile());
}

function addOrThrow(queue: PrintQueue, filename: string, source = 'local') {
  const result = queue.add(filename, source);
  if (!result.ok) throw new Error(result.message);
  return result.item;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eleg35-queue-'));
  initDataPaths(dir);
  printer = new StubPrinter();
  bridge = new StubBridge();
});

afterEach(() => {
  resetDataPathsForTest();
  rmSync(dir, { recursive: true, force: true });
});

describe('editing the queue', () => {
  it('adds jobs to the end, in order', () => {
    const q = makeQueue();
    addOrThrow(q, 'fixture-a.gcode');
    addOrThrow(q, 'plates/fixture-b.gcode', 'u-disk');
    expect(q.snapshot().items.map((i) => [i.filename, i.source])).toEqual([
      ['fixture-a.gcode', 'local'],
      ['plates/fixture-b.gcode', 'u-disk'],
    ]);
  });

  it('refuses a missing filename, an unknown source, control characters and an overfull queue', () => {
    const q = makeQueue();
    expect(q.add('', 'local').ok).toBe(false);
    expect(q.add(42, 'local').ok).toBe(false);
    expect(q.add('fixture.gcode', 'sd-card').ok).toBe(false);
    expect(q.add('fixture\n.gcode', 'local').ok).toBe(false);
    for (let i = 0; i < QUEUE_MAX_ITEMS; i++) addOrThrow(q, `fixture-${i}.gcode`);
    expect(q.add('one-too-many.gcode', 'local').ok).toBe(false);
    expect(q.snapshot().items).toHaveLength(QUEUE_MAX_ITEMS);
  });

  it('removes a job by id and reports an unknown id', () => {
    const q = makeQueue();
    const a = addOrThrow(q, 'fixture-a.gcode');
    addOrThrow(q, 'fixture-b.gcode');
    expect(q.remove(a.id)).toBe(true);
    expect(q.remove(a.id)).toBe(false);
    expect(q.snapshot().items.map((i) => i.filename)).toEqual(['fixture-b.gcode']);
  });

  it('reorders a job, clamping the target index to the list', () => {
    const q = makeQueue();
    addOrThrow(q, 'fixture-a.gcode');
    addOrThrow(q, 'fixture-b.gcode');
    const c = addOrThrow(q, 'fixture-c.gcode');
    expect(q.move(c.id, 0)).toBe(true);
    expect(q.snapshot().items.map((i) => i.filename)).toEqual([
      'fixture-c.gcode',
      'fixture-a.gcode',
      'fixture-b.gcode',
    ]);
    expect(q.move(c.id, 99)).toBe(true);
    expect(q.snapshot().items.map((i) => i.filename)).toEqual([
      'fixture-a.gcode',
      'fixture-b.gcode',
      'fixture-c.gcode',
    ]);
    expect(q.move('no-such-id', 0)).toBe(false);
  });

  it('clears the waiting list', () => {
    const q = makeQueue();
    addOrThrow(q, 'fixture-a.gcode');
    addOrThrow(q, 'fixture-b.gcode');
    q.clear();
    expect(q.snapshot().items).toEqual([]);
  });

  it('announces every change with a snapshot', () => {
    const q = makeQueue();
    const seen: number[] = [];
    q.on('change', (snap: { items: unknown[] }) => seen.push(snap.items.length));
    addOrThrow(q, 'fixture-a.gcode');
    addOrThrow(q, 'fixture-b.gcode');
    q.clear();
    expect(seen).toEqual([1, 2, 0]);
  });

  it('moveItem leaves an out-of-range source index alone', () => {
    expect(moveItem(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
    expect(moveItem(['a', 'b', 'c'], 2, -3)).toEqual(['c', 'a', 'b']);
  });
});

describe('persistence under DATA_DIR', () => {
  it('writes print-queue.json inside the configured data directory', () => {
    const q = makeQueue();
    addOrThrow(q, 'fixture-a.gcode');
    expect(printQueueFile()).toBe(join(dir, 'print-queue.json'));
    expect(existsSync(join(dir, 'print-queue.json'))).toBe(true);
    expect(printQueueFile()).not.toContain(process.cwd());
  });

  it('restores the list after a restart and dispatches nothing on load', () => {
    const first = makeQueue();
    addOrThrow(first, 'fixture-a.gcode');
    addOrThrow(first, 'fixture-b.gcode', 'u-disk');

    const second = makeQueue();
    second.load();
    expect(second.snapshot().items.map((i) => i.filename)).toEqual([
      'fixture-a.gcode',
      'fixture-b.gcode',
    ]);
    expect(second.snapshot().hold).toBeNull();
    expect(bridge.starts()).toHaveLength(0);
  });

  it('comes back held, with the job at the head, when the service restarted before a dispatched job started', () => {
    const first = makeQueue();
    const a = addOrThrow(first, 'fixture-a.gcode');
    addOrThrow(first, 'fixture-b.gcode');
    expect(first.startNext({ id: a.id, bedCleared: true }).ok).toBe(true);

    const second = makeQueue();
    second.load();
    const snap = second.snapshot();
    expect(snap.hold?.reason).toContain('restarted');
    expect(snap.active).toBeNull();
    expect(snap.items.map((i) => i.filename)).toEqual(['fixture-a.gcode', 'fixture-b.gcode']);
    // One start from before the "restart"; loading added none.
    expect(bridge.starts()).toHaveLength(1);
  });

  it('comes back held without re-queuing a job that had already started printing', () => {
    const first = makeQueue();
    const a = addOrThrow(first, 'fixture-a.gcode');
    addOrThrow(first, 'fixture-b.gcode');
    first.startNext({ id: a.id, bedCleared: true });
    printer.event({ type: 'print_started', filename: 'fixture-a.gcode' });

    const second = makeQueue();
    second.load();
    expect(second.snapshot().hold).not.toBeNull();
    expect(second.snapshot().items.map((i) => i.filename)).toEqual(['fixture-b.gcode']);
  });

  it('ignores an unreadable file rather than failing', () => {
    writeFileSync(printQueueFile(), '{not json');
    const q = makeQueue();
    q.load();
    expect(q.snapshot().items).toEqual([]);
    expect(parsePersistedQueue('{"version":2}')).toBeNull();
  });
});

describe('start next', () => {
  it('dispatches exactly one 1020 for the head job, with its source and the dialog config', () => {
    const q = makeQueue();
    const a = addOrThrow(q, 'plates/fixture-a.gcode', 'u-disk');
    addOrThrow(q, 'fixture-b.gcode');
    const config = {
      delay_video: true,
      print_layout: 'B',
      slot_map: [{ t: 0, canvas_id: 0, tray_id: 2 }],
    };

    const result = q.startNext({ id: a.id, bedCleared: true, config });

    expect(result.ok).toBe(true);
    expect(bridge.calls).toEqual([
      {
        method: 1020,
        params: { storage_media: 'u-disk', filename: 'plates/fixture-a.gcode', config },
      },
    ]);
    const snap = q.snapshot();
    expect(snap.items.map((i) => i.filename)).toEqual(['fixture-b.gcode']);
    expect(snap.active?.item.id).toBe(a.id);
    // Persisted too, so a restart knows a job was out.
    expect(JSON.parse(readFileSync(printQueueFile(), 'utf-8')).active.item.id).toBe(a.id);
  });

  it('refuses without the bed-clear confirmation', () => {
    const q = makeQueue();
    const a = addOrThrow(q, 'fixture-a.gcode');
    const result = q.startNext({ id: a.id });
    expect(result).toMatchObject({ ok: false, code: 'confirmation_required' });
    expect(!result.ok && result.message).toContain(BED_CLEAR_REMINDER);
    expect(q.startNext({ id: a.id, bedCleared: 'true' }).ok).toBe(false);
    expect(bridge.starts()).toHaveLength(0);
  });

  it('refuses while the printer is printing', () => {
    const q = makeQueue();
    const a = addOrThrow(q, 'fixture-a.gcode');
    printer.set(2, 0);
    expect(q.startNext({ id: a.id, bedCleared: true })).toMatchObject({
      ok: false,
      code: 'printing',
    });
    expect(bridge.starts()).toHaveLength(0);
    expect(q.snapshot().items).toHaveLength(1);
  });

  it('refuses while the printer is paused', () => {
    const q = makeQueue();
    const a = addOrThrow(q, 'fixture-a.gcode');
    printer.set(2, 2502);
    expect(q.startNext({ id: a.id, bedCleared: true })).toMatchObject({
      ok: false,
      code: 'paused',
    });
    expect(bridge.starts()).toHaveLength(0);
  });

  it('refuses while the printer is busy or not reporting', () => {
    const q = makeQueue();
    const a = addOrThrow(q, 'fixture-a.gcode');
    printer.set(5);
    expect(q.startNext({ id: a.id, bedCleared: true })).toMatchObject({ ok: false, code: 'busy' });
    printer.status = null;
    expect(q.startNext({ id: a.id, bedCleared: true })).toMatchObject({
      ok: false,
      code: 'unknown',
    });
    expect(bridge.starts()).toHaveLength(0);
  });

  it('allows a start when the printer sits in status 2 with a completed sub-status', () => {
    const q = makeQueue();
    const a = addOrThrow(q, 'fixture-a.gcode');
    printer.set(2, 2077);
    expect(q.startNext({ id: a.id, bedCleared: true }).ok).toBe(true);
    expect(bridge.starts()).toHaveLength(1);
  });

  it('refuses a confirmation for a job that is no longer at the head', () => {
    const q = makeQueue();
    const a = addOrThrow(q, 'fixture-a.gcode');
    const b = addOrThrow(q, 'fixture-b.gcode');
    q.move(b.id, 0);
    expect(q.startNext({ id: a.id, bedCleared: true })).toMatchObject({ ok: false, code: 'stale' });
    expect(bridge.starts()).toHaveLength(0);
  });

  it('refuses when the queue is empty', () => {
    const q = makeQueue();
    expect(q.startNext({ id: 'x', bedCleared: true })).toMatchObject({ ok: false, code: 'empty' });
  });

  it('refuses a second start while a dispatched job has not ended', () => {
    const q = makeQueue();
    const a = addOrThrow(q, 'fixture-a.gcode');
    const b = addOrThrow(q, 'fixture-b.gcode');
    q.startNext({ id: a.id, bedCleared: true });
    // The printer has not reported printing yet: only the dispatched-job guard applies.
    expect(q.startNext({ id: b.id, bedCleared: true })).toMatchObject({
      ok: false,
      code: 'active',
    });
    expect(bridge.starts()).toHaveLength(1);
  });

  it('forwards only the config keys the print dialog sends', () => {
    expect(
      sanitiseStartConfig({
        delay_video: false,
        printer_check: 'yes',
        print_layout: 'Z',
        bedlevel_force: false,
        slot_map: [{ t: 0, canvas_id: 0, tray_id: 1, extra: true }, { t: 'x' }],
        gcode: 'G28',
      }),
    ).toEqual({
      delay_video: false,
      bedlevel_force: false,
      slot_map: [{ t: 0, canvas_id: 0, tray_id: 1 }],
    });
    expect(sanitiseStartConfig('nope')).toBeUndefined();
  });
});

describe('between jobs', () => {
  it('does not dispatch the next job when one completes — only on the next explicit confirmation', () => {
    const q = makeQueue();
    const a = addOrThrow(q, 'fixture-a.gcode');
    const b = addOrThrow(q, 'fixture-b.gcode');
    q.startNext({ id: a.id, bedCleared: true });
    printer.set(2, 0);
    printer.event({ type: 'print_started', filename: 'fixture-a.gcode' });
    // Idle BEFORE the completion event on purpose: with the printer still reporting
    // "printing", the printing refusal would absorb an auto-advance and this test could
    // not tell the two guards apart.
    printer.set(1, 2077);
    printer.event({ type: 'print_completed', filename: 'fixture-a.gcode', duration: 60 });

    expect(bridge.starts()).toHaveLength(1);
    const snap = q.snapshot();
    expect(snap.active).toBeNull();
    expect(snap.items.map((i) => i.id)).toEqual([b.id]);
    expect(snap.lastFinished?.filename).toBe('fixture-a.gcode');

    expect(q.startNext({ id: b.id, bedCleared: true }).ok).toBe(true);
    expect(bridge.starts().map((c) => c.params.filename)).toEqual([
      'fixture-a.gcode',
      'fixture-b.gcode',
    ]);
  });

  it('holds the queue when a job fails or is stopped, and says why', () => {
    const q = makeQueue();
    const a = addOrThrow(q, 'fixture-a.gcode');
    const b = addOrThrow(q, 'fixture-b.gcode');
    q.startNext({ id: a.id, bedCleared: true });
    printer.event({ type: 'print_started', filename: 'fixture-a.gcode' });
    printer.set(1, 2504);
    printer.event({ type: 'print_failed', filename: 'fixture-a.gcode', reason: 'Stopped' });

    const snap = q.snapshot();
    expect(snap.hold?.reason).toContain('Stopped');
    expect(snap.active).toBeNull();
    const refused = q.startNext({ id: b.id, bedCleared: true });
    expect(refused).toMatchObject({ ok: false, code: 'held' });
    expect(bridge.starts()).toHaveLength(1);
  });

  it('resuming releases the hold without starting anything', () => {
    const q = makeQueue();
    const a = addOrThrow(q, 'fixture-a.gcode');
    const b = addOrThrow(q, 'fixture-b.gcode');
    q.startNext({ id: a.id, bedCleared: true });
    printer.event({ type: 'print_failed', filename: 'fixture-a.gcode', reason: 'Stopped' });

    q.resume();
    expect(q.snapshot().hold).toBeNull();
    expect(bridge.starts()).toHaveLength(1);
    expect(q.startNext({ id: b.id, bedCleared: true }).ok).toBe(true);
  });

  it('holds the queue and puts the job back when the printer refuses the start', () => {
    const q = makeQueue();
    const a = addOrThrow(q, 'fixture-a.gcode');
    addOrThrow(q, 'fixture-b.gcode');
    q.startNext({ id: a.id, bedCleared: true });
    printer.emit('response', 1020, { method: 1020, result: { error_code: 1003 } });

    const snap = q.snapshot();
    expect(snap.hold?.reason).toContain('refused');
    expect(snap.items.map((i) => i.filename)).toEqual(['fixture-a.gcode', 'fixture-b.gcode']);
    expect(snap.active).toBeNull();
  });

  it('ignores a successful 1020 response', () => {
    const q = makeQueue();
    const a = addOrThrow(q, 'fixture-a.gcode');
    q.startNext({ id: a.id, bedCleared: true });
    printer.emit('response', 1020, { method: 1020, result: { error_code: 0 } });
    expect(q.snapshot().hold).toBeNull();
    expect(q.snapshot().active?.item.id).toBe(a.id);
  });

  it('pays no attention to print events when the queue is empty', () => {
    const q = makeQueue();
    printer.event({ type: 'print_failed', filename: 'manual.gcode', reason: 'Stopped' });
    expect(q.snapshot().hold).toBeNull();
  });
});

describe('printer switch (ELEG-107)', () => {
  it('clears items, a hold and lastFinished, and persists the empty state', () => {
    const q = makeQueue();
    const a = addOrThrow(q, 'fixture-a.gcode');
    addOrThrow(q, 'fixture-b.gcode');
    q.startNext({ id: a.id, bedCleared: true });
    printer.event({ type: 'print_completed', filename: 'fixture-a.gcode', duration: 60 });
    // b is still queued: firing a failure now holds the queue without a second dispatch.
    printer.event({ type: 'print_failed', filename: 'fixture-b.gcode', reason: 'Stopped' });
    // Arrange sanity: there really is state to clear.
    const before = q.snapshot();
    expect(before.items).toHaveLength(1);
    expect(before.hold).not.toBeNull();
    expect(before.lastFinished?.filename).toBe('fixture-a.gcode');

    q.resetForPrinterSwitch();

    expect(q.snapshot()).toEqual({ items: [], active: null, hold: null, lastFinished: null });

    // Persisted too: a fresh queue reading the same file has nothing to restore.
    const reloaded = makeQueue();
    reloaded.load();
    expect(reloaded.snapshot()).toEqual({
      items: [],
      active: null,
      hold: null,
      lastFinished: null,
    });
  });

  it('clears an in-flight active job too, so it can never be reported finished by the new printer', () => {
    const q = makeQueue();
    const a = addOrThrow(q, 'fixture-a.gcode');
    q.startNext({ id: a.id, bedCleared: true });
    expect(q.snapshot().active).not.toBeNull();

    q.resetForPrinterSwitch();

    expect(q.snapshot().active).toBeNull();
    const reloaded = makeQueue();
    reloaded.load();
    expect(reloaded.snapshot().active).toBeNull();
  });

  it('leaves "start next" with nothing to start for the old printer\'s paths', () => {
    const q = makeQueue();
    const a = addOrThrow(q, 'fixture-a.gcode');
    addOrThrow(q, 'fixture-b.gcode');

    q.resetForPrinterSwitch();

    const result = q.startNext({ id: a.id, bedCleared: true });
    expect(result).toMatchObject({ ok: false, code: 'empty' });
    expect(bridge.starts()).toHaveLength(0);
  });

  it('ignores a print event that arrives afterwards for a job it no longer holds', () => {
    const q = makeQueue();
    const a = addOrThrow(q, 'fixture-a.gcode');
    q.startNext({ id: a.id, bedCleared: true });
    q.resetForPrinterSwitch();

    printer.event({ type: 'print_completed', filename: 'fixture-a.gcode', duration: 60 });
    expect(q.snapshot().lastFinished).toBeNull();

    printer.event({ type: 'print_failed', filename: 'fixture-a.gcode', reason: 'Stopped' });
    expect(q.snapshot().hold).toBeNull();
  });

  it('ignores a stale 1020 response for the job it dispatched before the switch', () => {
    const q = makeQueue();
    const a = addOrThrow(q, 'fixture-a.gcode');
    q.startNext({ id: a.id, bedCleared: true });
    q.resetForPrinterSwitch();

    printer.emit('response', 1020, { method: 1020, result: { error_code: 1003 } });
    expect(q.snapshot()).toEqual({ items: [], active: null, hold: null, lastFinished: null });
  });
});

describe('printerActivity', () => {
  it('classifies the statuses start next depends on', () => {
    expect(printerActivity(1, 0)).toBe('idle');
    expect(printerActivity(2, 0)).toBe('printing');
    expect(printerActivity(2, 2502)).toBe('paused');
    expect(printerActivity(2, 2505)).toBe('paused');
    expect(printerActivity(2, 2077)).toBe('ended');
    expect(printerActivity(2, 2504)).toBe('ended');
    expect(printerActivity(10, 0)).toBe('busy');
    expect(printerActivity(undefined, undefined)).toBe('unknown');
    expect(printerActivity(-1, 0)).toBe('unknown');
  });
});
