/**
 * Print queue card — the pure half (ELEG-35).
 *
 * Free of DOM and fetch so it runs under vitest's `node` environment, like `list-sort.ts`
 * and `card-layout.ts`. `ui/print-queue.ts` owns the markup, the requests and the events;
 * this decides what the card says and whether "Start next" can be pressed.
 *
 * The button state is advice to the human, not the guard. The service refuses the same
 * cases in `PrintQueue.startNext`, so a stale page cannot start anything the service
 * would not.
 */

import {
  BED_CLEAR_REMINDER,
  type QueueSnapshot,
  canStartWith,
  printerActivity,
} from '../print-queue-shared';

/** The last path segment — what a person recognises a file by. */
export function baseName(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

export interface StartNextView {
  enabled: boolean;
  /** One sentence explaining the state — always shown, so a disabled button says why. */
  hint: string;
  /** True when the hint is a hold or refusal that needs attention. */
  warning: boolean;
}

export function startNextView(
  queue: QueueSnapshot | null,
  machineStatus: number | null | undefined,
  subStatus: number | null | undefined,
): StartNextView {
  if (!queue) return { enabled: false, hint: 'Loading the queue…', warning: false };
  if (queue.hold) {
    return {
      enabled: false,
      hint: `Queue paused. ${queue.hold.reason}`,
      warning: true,
    };
  }
  const head = queue.items[0];
  if (queue.active) {
    return {
      enabled: false,
      hint: `"${baseName(queue.active.item.filename)}" was started from the queue — the next job waits until it ends.`,
      warning: false,
    };
  }
  if (!head) {
    return {
      enabled: false,
      hint: 'The queue is empty. Add files with ＋ on the Files card.',
      warning: false,
    };
  }
  const activity = printerActivity(machineStatus, subStatus);
  if (!canStartWith(activity)) {
    const why: Record<string, string> = {
      printing: 'The printer is printing — the next job waits until this one ends.',
      paused: 'The printer has a paused print — resume or stop it first.',
      busy: 'The printer is busy — the next job can start when it is idle.',
      unknown: 'The printer is not reporting its status.',
    };
    return { enabled: false, hint: why[activity], warning: false };
  }
  const finished = queue.lastFinished
    ? `"${baseName(queue.lastFinished.filename)}" finished. `
    : '';
  return {
    enabled: true,
    hint: `${finished}${BED_CLEAR_REMINDER} Next: "${baseName(head.filename)}".`,
    warning: false,
  };
}

export interface QueueRow {
  id: string;
  name: string;
  path: string;
  source: string;
  position: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
}

export function queueRows(queue: QueueSnapshot | null): QueueRow[] {
  if (!queue) return [];
  const last = queue.items.length - 1;
  return queue.items.map((item, index) => ({
    id: item.id,
    name: baseName(item.filename),
    path: item.filename,
    source: item.source === 'u-disk' ? 'USB' : 'Local',
    position: index + 1,
    canMoveUp: index > 0,
    canMoveDown: index < last,
  }));
}
