/**
 * Export the MQTT log as JSON (ELEG-31).
 *
 * Both log views are browser-only and scroll away, so when something odd happens on the
 * printer there is no way to hand anyone the evidence.
 *
 * ## The format is not a new one, deliberately
 *
 * The output is byte-compatible with the server-side capture files that
 * `POST /api/debug/capture` writes into `data/logs/`: a plain array of
 * `{ direction, topic, data, ts }`, newest last.
 *
 * That matters because of the second reason this exists. ELEG-28 wants delta-merge
 * tests built from captured real payloads, and a browser export in its own shape would
 * mean two fixture formats and a converter between them. Matching the existing one
 * means anything already able to read a capture can read an export.
 *
 * `data` is the **full parsed message** (`LogEntry.raw`), not `LogEntry.payload` — the
 * latter is truncated to 500 characters for display and is useless as a fixture.
 */

import type { LogEntry, LogDirection } from '../log-store';

/** One message, in the same shape `data/logs/mqtt-capture-*.json` uses. */
export interface CapturedMessage {
  direction: LogDirection;
  topic: string;
  data: unknown;
  ts: number;
}

/** Convert log entries to the capture format. Pure. */
export function toCaptureFormat(entries: readonly LogEntry[]): CapturedMessage[] {
  return entries.map((e) => ({
    direction: e.direction,
    topic: e.topic,
    data: e.raw,
    ts: e.timestamp,
  }));
}

/**
 * Filename for an export, matching the server's `mqtt-capture-<iso>.json` convention
 * with the view name folded in so two exports from one session do not collide.
 *
 * Colons and dots are replaced because Windows rejects them in filenames and a browser
 * download is the one place this reliably bites.
 */
export function captureFilename(now: Date, view: string): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `mqtt-${view}-${stamp}.json`;
}

/** Trigger a browser download of `payload` as pretty-printed JSON. */
export function downloadJson(filename: string, payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Without this the blob is held for the life of the document.
  URL.revokeObjectURL(url);
}

/**
 * Export the entries a view is currently showing.
 *
 * **Filtered, not the whole buffer** — the filter is how you found the interesting
 * thing, and an unfiltered dump is what people already cannot read.
 */
export function exportLogEntries(entries: readonly LogEntry[], view: string): number {
  const messages = toCaptureFormat(entries);
  downloadJson(captureFilename(new Date(), view), messages);
  return messages.length;
}
