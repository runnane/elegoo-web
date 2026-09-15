/**
 * Print queue — the shapes and decisions the service and the browser agree on (ELEG-35).
 *
 * The printer has no queue: nothing in the CC2 protocol holds one, so the list lives in
 * the service (`src/server/print-queue.ts`) and the browser renders it. **Every job is
 * started by a human.** The queue saves re-navigating the file browser and remembers
 * what is next; it never decides to start a physical machine because a previous job
 * finished, because the bed is not cleared between jobs and a queue that starts print #2
 * onto print #1 is the default outcome of doing so.
 *
 * Imported by both halves, so it holds no DOM, no Node API and no relative import: the
 * service resolves it as `../print-queue-shared.js`, vite as `../print-queue-shared`.
 */

/** A queue longer than this is almost certainly a script, not a person planning a day. */
export const QUEUE_MAX_ITEMS = 50;

/** The storage the Files card can browse — the same values it sends as `storage_media`. */
export const QUEUE_SOURCES = ['local', 'u-disk'] as const;
export type QueueSource = (typeof QUEUE_SOURCES)[number];

/**
 * The reminder shown before every queued start, and the text of the refusal a start
 * without confirmation gets. One constant so the two cannot drift apart.
 */
export const BED_CLEAR_REMINDER =
  'Clear the bed first: remove the previous print before starting the next job.';

/** The checkbox a human ticks in the print dialog to confirm it. */
export const BED_CLEAR_CONFIRM_LABEL = 'The bed is clear — start this job';

export interface QueueItem {
  id: string;
  /** Full path on the printer, exactly as the print dialog sends it in method 1020. */
  filename: string;
  source: QueueSource;
  addedAt: number;
}

/** A job the queue dispatched and has not yet seen end. */
export interface QueueActive {
  item: QueueItem;
  dispatchedAt: number;
  /** True once the store reported the print starting. */
  started: boolean;
}

/** Why the queue is paused. "Start next" is refused until a human resumes it. */
export interface QueueHold {
  reason: string;
  at: number;
}

export interface QueueFinished {
  filename: string;
  at: number;
}

export interface QueueSnapshot {
  items: QueueItem[];
  active: QueueActive | null;
  hold: QueueHold | null;
  lastFinished: QueueFinished | null;
}

export type PrinterActivity = 'idle' | 'ended' | 'printing' | 'paused' | 'busy' | 'unknown';

/** Pausing, Paused, Filament Interruption — the same set the compat layers call paused. */
const PAUSED_SUB_STATUS = new Set([2501, 2502, 2505]);
/** Print Complete, Stopped — the printer can sit in status 2 with these after a job. */
const ENDED_SUB_STATUS = new Set([2077, 2504]);

/**
 * What the printer is doing, as far as starting the next job is concerned.
 *
 * `ended` is status 2 with a completed/stopped sub-status: the state-store's own new-print
 * detection shows the printer can remain there after a job, and it is not printing.
 * Only `idle` and `ended` allow a start.
 */
export function printerActivity(
  machineStatus: number | null | undefined,
  subStatus: number | null | undefined,
): PrinterActivity {
  if (machineStatus === 1) return 'idle';
  if (machineStatus === 2) {
    const sub = subStatus ?? -1;
    if (PAUSED_SUB_STATUS.has(sub)) return 'paused';
    if (ENDED_SUB_STATUS.has(sub)) return 'ended';
    return 'printing';
  }
  if (machineStatus === null || machineStatus === undefined || machineStatus < 0) {
    return 'unknown';
  }
  return 'busy';
}

export function canStartWith(activity: PrinterActivity): boolean {
  return activity === 'idle' || activity === 'ended';
}
