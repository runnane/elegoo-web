/**
 * Print queue — the service half (ELEG-35).
 *
 * **A queue with mandatory confirmation between jobs.** The service holds the ordered
 * list; a human confirms every start. Three rules carry the design, and each has a test
 * that goes red without it:
 *
 * 1. **Nothing advances on its own.** When a job completes the queue records that it
 *    finished and waits. The next start is a separate, explicit request carrying
 *    `bedCleared: true`, because the CC2 has no ejection and the part is still on the bed.
 * 2. **"Start next" is refused while the printer is printing, paused or busy**, while a
 *    job the queue dispatched has not yet ended, and while the queue is held.
 * 3. **A failed, stopped or refused job holds the queue.** Continuing after a failure is
 *    how one failed print becomes four. A human resumes it.
 *
 * **Restart behaviour.** The list is persisted under `DATA_DIR` and survives a restart.
 * Loading it never dispatches anything. A queue that was mid-job when the service went
 * down comes back *held*, since nobody can say what happened to that job or the bed while
 * the service was away.
 *
 * **The start path is the existing one.** The browser's print dialog builds the method
 * 1020 payload as it always has. In queue mode it posts that payload to
 * `/api/queue/start-next` rather than as a `/ws` command frame, and this module sends it
 * through `MqttBridge.sendCommand` — the same call `ws-transport.ts` makes for a command
 * frame. The only thing added is the refusal checks in front of it.
 *
 * One MQTT connection: this reads the store's events and sends through the bridge it is
 * handed. It never opens a client.
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { getLogger } from './logger.js';
import type { PrintEvent } from './state-store.js';
import {
  BED_CLEAR_REMINDER,
  QUEUE_MAX_ITEMS,
  QUEUE_SOURCES,
  type QueueActive,
  type QueueFinished,
  type QueueHold,
  type QueueItem,
  type QueueSnapshot,
  type QueueSource,
  canStartWith,
  printerActivity,
} from '../print-queue-shared.js';

const log = getLogger('Queue');

/** CC2 method 1020, StartPrint. */
export const START_PRINT_METHOD = 1020;

const MAX_FILENAME_LENGTH = 1024;

/** What the queue reads from the store. `StateStore` satisfies it; a test stub can too. */
export interface QueuePrinter {
  readonly status: { machine_status?: { status?: number; sub_status?: number } } | null;
  on(event: 'print_event', listener: (event: PrintEvent) => void): unknown;
  on(event: 'response', listener: (method: number, data: Record<string, unknown>) => void): unknown;
}

/** What the queue sends through. `MqttBridge` satisfies it. */
export interface QueueDispatcher {
  sendCommand(method: number, params: Record<string, unknown>): void;
}

export type StartRefusal =
  | 'confirmation_required'
  | 'empty'
  | 'held'
  | 'active'
  | 'printing'
  | 'paused'
  | 'busy'
  | 'unknown'
  | 'stale';

export type StartResult =
  | { ok: true; item: QueueItem }
  | { ok: false; code: StartRefusal; message: string };

export type AddResult = { ok: true; item: QueueItem } | { ok: false; message: string };

export interface StartNextRequest {
  /** The id of the item the human confirmed — refused if the head has since changed. */
  id?: unknown;
  /** Must be exactly `true`: the human confirmed the bed is clear. */
  bedCleared?: unknown;
  /** The print dialog's 1020 `config` block (slot map, plate, timelapse, levelling). */
  config?: unknown;
}

interface PersistedQueue {
  version: 1;
  savedAt: number;
  items: QueueItem[];
  active: QueueActive | null;
  hold: QueueHold | null;
  lastFinished: QueueFinished | null;
}

// ── Pure helpers ────────────────────────────────────────────────

/** Move one element to a new index, clamped to the list. Returns a new array. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const result = [...list];
  if (from < 0 || from >= result.length) return result;
  const target = Math.max(0, Math.min(result.length - 1, to));
  const [moved] = result.splice(from, 1);
  result.splice(target, 0, moved);
  return result;
}

function isSource(value: unknown): value is QueueSource {
  return typeof value === 'string' && (QUEUE_SOURCES as readonly string[]).includes(value);
}

function isItem(value: unknown): value is QueueItem {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.filename === 'string' &&
    v.filename.length > 0 &&
    isSource(v.source) &&
    typeof v.addedAt === 'number'
  );
}

/**
 * Keep only the keys the print dialog sends in 1020's `config`, with the types it sends
 * them as. Anything else in a request body is dropped rather than forwarded to the printer.
 */
export function sanitiseStartConfig(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ['delay_video', 'printer_check', 'bedlevel_force']) {
    if (typeof r[key] === 'boolean') out[key] = r[key];
  }
  if (r.print_layout === 'A' || r.print_layout === 'B') out.print_layout = r.print_layout;
  if (Array.isArray(r.slot_map)) {
    out.slot_map = r.slot_map
      .filter(
        (s): s is { t: number; canvas_id: number; tray_id: number } =>
          !!s &&
          typeof s === 'object' &&
          Number.isInteger((s as Record<string, unknown>).t) &&
          Number.isInteger((s as Record<string, unknown>).canvas_id) &&
          Number.isInteger((s as Record<string, unknown>).tray_id),
      )
      .map((s) => ({ t: s.t, canvas_id: s.canvas_id, tray_id: s.tray_id }));
  }
  return out;
}

/** A non-zero `error_code` from a response, wherever the payload put it. */
function responseErrorCode(data: Record<string, unknown> | undefined): number | null {
  if (!data) return null;
  const result = data.result as Record<string, unknown> | undefined;
  const code = (result?.error_code ?? data.error_code) as unknown;
  return typeof code === 'number' && code !== 0 ? code : null;
}

/** Parse a persisted queue, dropping anything malformed rather than failing the load. */
export function parsePersistedQueue(raw: string): PersistedQueue | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.version !== 1) return null;
  const items = Array.isArray(d.items) ? d.items.filter(isItem).slice(0, QUEUE_MAX_ITEMS) : [];
  const a = d.active as Record<string, unknown> | null | undefined;
  const active =
    a && isItem(a.item) && typeof a.dispatchedAt === 'number'
      ? { item: a.item, dispatchedAt: a.dispatchedAt, started: a.started === true }
      : null;
  const h = d.hold as Record<string, unknown> | null | undefined;
  const hold =
    h && typeof h.reason === 'string' && typeof h.at === 'number'
      ? { reason: h.reason, at: h.at }
      : null;
  const f = d.lastFinished as Record<string, unknown> | null | undefined;
  const lastFinished =
    f && typeof f.filename === 'string' && typeof f.at === 'number'
      ? { filename: f.filename, at: f.at }
      : null;
  return {
    version: 1,
    savedAt: typeof d.savedAt === 'number' ? d.savedAt : 0,
    items,
    active,
    hold,
    lastFinished,
  };
}

// ── The queue ───────────────────────────────────────────────────

export class PrintQueue extends EventEmitter {
  private items: QueueItem[] = [];
  private active: QueueActive | null = null;
  private hold: QueueHold | null = null;
  private lastFinished: QueueFinished | null = null;
  private readonly now: () => number;

  constructor(
    private readonly printer: QueuePrinter,
    private readonly dispatcher: QueueDispatcher,
    private readonly filePath: string,
    options: { now?: () => number } = {},
  ) {
    super();
    this.now = options.now ?? Date.now;
    printer.on('print_event', (event) => this.onPrintEvent(event));
    printer.on('response', (method, data) => this.onResponse(method, data));
  }

  /**
   * Restore the queue from disk. **Never dispatches.** A job that was dispatched before
   * the restart holds the queue; one that had not yet started goes back to the head so it
   * is not silently lost.
   */
  load(): void {
    let raw: string;
    try {
      if (!existsSync(this.filePath)) return;
      raw = readFileSync(this.filePath, 'utf-8');
    } catch (err) {
      log.warn(`Failed to read queue: ${(err as Error).message}`);
      return;
    }
    const persisted = parsePersistedQueue(raw);
    if (!persisted) {
      log.warn('Ignoring unreadable print-queue.json');
      return;
    }
    this.items = persisted.items;
    this.hold = persisted.hold;
    this.lastFinished = persisted.lastFinished;
    this.active = null;
    if (persisted.active) {
      const { item, started } = persisted.active;
      if (!started) this.items = [item, ...this.items].slice(0, QUEUE_MAX_ITEMS);
      this.hold = {
        reason: `The service restarted while "${item.filename}" was ${started ? 'printing' : 'being started'} from the queue. Check the printer and the bed, then resume.`,
        at: this.now(),
      };
      this.save();
    }
    log.info(`Restored ${this.items.length} queued job(s)${this.hold ? ' (held)' : ''}`);
  }

  snapshot(): QueueSnapshot {
    return {
      items: this.items.map((i) => ({ ...i })),
      active: this.active ? { ...this.active, item: { ...this.active.item } } : null,
      hold: this.hold ? { ...this.hold } : null,
      lastFinished: this.lastFinished ? { ...this.lastFinished } : null,
    };
  }

  add(filename: unknown, source: unknown = 'local'): AddResult {
    if (typeof filename !== 'string' || filename.trim() === '') {
      return { ok: false, message: 'filename is required' };
    }
    // Control characters have no business in a printer path, and a very long string is
    // not one either.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
    if (filename.length > MAX_FILENAME_LENGTH || /[ -]/.test(filename)) {
      return { ok: false, message: 'filename is not a valid printer path' };
    }
    if (!isSource(source)) {
      return { ok: false, message: `source must be one of: ${QUEUE_SOURCES.join(', ')}` };
    }
    if (this.items.length >= QUEUE_MAX_ITEMS) {
      return { ok: false, message: `The queue holds at most ${QUEUE_MAX_ITEMS} jobs` };
    }
    const item: QueueItem = { id: randomUUID(), filename, source, addedAt: this.now() };
    this.items = [...this.items, item];
    this.changed();
    return { ok: true, item: { ...item } };
  }

  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.id !== id);
    if (this.items.length === before) return false;
    this.changed();
    return true;
  }

  move(id: string, toIndex: number): boolean {
    const from = this.items.findIndex((i) => i.id === id);
    if (from < 0) return false;
    this.items = moveItem(this.items, from, toIndex);
    this.changed();
    return true;
  }

  /** Empty the waiting list. A dispatched job and a hold are left as they are. */
  clear(): void {
    this.items = [];
    this.changed();
  }

  /**
   * Release a hold. If a dispatched job never started and the printer is not running
   * anything, it goes back to the head of the list. Resuming never starts a job.
   */
  resume(): void {
    this.hold = null;
    if (this.active && !this.active.started && canStartWith(this.activity())) {
      this.items = [this.active.item, ...this.items].slice(0, QUEUE_MAX_ITEMS);
      this.active = null;
    }
    this.changed();
  }

  /** The explicit, human-confirmed start of the job at the head of the queue. */
  startNext(request: StartNextRequest): StartResult {
    if (request.bedCleared !== true) {
      return {
        ok: false,
        code: 'confirmation_required',
        message: `Confirm the bed is clear. ${BED_CLEAR_REMINDER}`,
      };
    }
    const head = this.items[0];
    if (!head) return { ok: false, code: 'empty', message: 'The queue is empty' };
    if (this.hold) {
      return {
        ok: false,
        code: 'held',
        message: `The queue is paused: ${this.hold.reason}`,
      };
    }
    if (this.active) {
      return {
        ok: false,
        code: 'active',
        message: `"${this.active.item.filename}" was started from the queue and has not finished yet`,
      };
    }
    const activity = this.activity();
    if (!canStartWith(activity)) {
      const messages: Record<string, string> = {
        printing: 'The printer is printing — the next job waits until this one ends',
        paused: 'The printer has a paused print — resume or stop it first',
        busy: 'The printer is busy — try again when it is idle',
        unknown: 'The printer is not reporting its status — check the connection',
      };
      return { ok: false, code: activity as StartRefusal, message: messages[activity] };
    }
    if (request.id !== head.id) {
      return {
        ok: false,
        code: 'stale',
        message: `The queue changed — the next job is now "${head.filename}"`,
      };
    }

    const params: Record<string, unknown> = {
      storage_media: head.source,
      filename: head.filename,
    };
    const config = sanitiseStartConfig(request.config);
    if (config) params.config = config;
    this.dispatcher.sendCommand(START_PRINT_METHOD, params);
    log.info(`Start dispatched from queue: ${head.filename} (${head.source})`);

    this.items = this.items.slice(1);
    this.active = { item: head, dispatchedAt: this.now(), started: false };
    this.lastFinished = null;
    this.changed();
    return { ok: true, item: { ...head } };
  }

  private activity() {
    const ms = this.printer.status?.machine_status;
    return printerActivity(ms?.status, ms?.sub_status);
  }

  private onPrintEvent(event: PrintEvent): void {
    switch (event.type) {
      case 'print_started':
        if (this.active && !this.active.started) {
          this.active = { ...this.active, started: true };
          this.changed();
        }
        return;
      case 'print_completed':
        if (!this.active && this.items.length === 0) return;
        this.active = null;
        this.lastFinished = { filename: event.filename, at: this.now() };
        // Deliberately nothing else. The finished part is still on the bed; the next job
        // waits for a human to clear it and confirm (ELEG-35).
        this.changed();
        return;
      case 'print_failed':
        if (!this.active && this.items.length === 0) return;
        this.active = null;
        this.hold = {
          reason: `"${event.filename}" did not finish (${event.reason}). Check the printer and clear the bed, then resume.`,
          at: this.now(),
        };
        log.warn(`Queue held: ${event.filename} ended with ${event.reason}`);
        this.changed();
        return;
    }
  }

  /** The printer answering 1020 with an error for a job the queue dispatched. */
  private onResponse(method: number, data: Record<string, unknown>): void {
    if (method !== START_PRINT_METHOD || !this.active || this.active.started) return;
    const code = responseErrorCode(data);
    if (code === null) return;
    const { item } = this.active;
    this.active = null;
    this.items = [item, ...this.items].slice(0, QUEUE_MAX_ITEMS);
    this.hold = {
      reason: `The printer refused to start "${item.filename}" (error ${code}). It is back at the head of the queue.`,
      at: this.now(),
    };
    log.warn(`Queue held: printer refused 1020 for ${item.filename} (error ${code})`);
    this.changed();
  }

  private changed(): void {
    this.save();
    this.emit('change', this.snapshot());
  }

  private save(): void {
    const data: PersistedQueue = {
      version: 1,
      savedAt: this.now(),
      items: this.items,
      active: this.active,
      hold: this.hold,
      lastFinished: this.lastFinished,
    };
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(data), 'utf-8');
      renameSync(tmp, this.filePath);
    } catch (err) {
      log.warn(`Failed to save queue: ${(err as Error).message}`);
    }
  }
}
