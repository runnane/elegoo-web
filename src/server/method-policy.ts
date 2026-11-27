/**
 * Which CC2 method numbers are reads, for the write gate (ELEG-25 plan 3c, ELEG-140).
 *
 * **Default-deny.** A method is a read only if it is listed here, and it is listed only
 * with evidence. Everything else — every known write, every method nobody has looked at,
 * and every method whose meaning is merely *plausible* — needs the service API key. A
 * misclassification in this direction costs an anonymous viewer a panel; the opposite
 * direction would leave a write open, so nothing goes on this list on a hunch.
 *
 * **What does not count as evidence:** `METHOD_NAMES` in `src/ui/log-methods.ts`. It is a
 * display label for the log viewer and has been wrong three times (1049 was labelled a
 * history delete and actually writes the printer's auth token — ELEG-38/57). Nor does a
 * method name in an issue.
 *
 * **What was not available:** the protocol references (`data/CC2_PROTOCOL_REFERENCE.md`,
 * `data/CC2-OFFICIAL-APP-PATTERNS.md`) are gitignored and were not on the machine this
 * list was written on (ELEG-66). Where a reference finding is cited below, it is one that
 * an earlier change recorded *in committed code or a commit message* while holding the
 * reference, and the citation says where. No method was fired at the printer to find out.
 *
 * Evidence, strongest first:
 *   A. **The service sends it itself, unprompted**, and the reply only feeds `StateStore`.
 *      A method this service fires on every MQTT registration, on a 5 s poll, or in the
 *      middle of a print cannot change printer state — it would have been doing so for the
 *      life of the repo.
 *   B. **A recorded reference finding** plus a reply that carries the data asked for.
 *   C. **Observed behaviour**: the reply carries data the request only identified, and the
 *      SPA fires it unprompted for every rendered row.
 */

/** Method → the evidence that it is a read. Pinned by `ws-auth.test.ts`. */
export const READ_METHODS: ReadonlyMap<number, string> = new Map([
  [
    1002,
    // A. GetStatus.
    'A: the service sends it on every MQTT registration (mqtt-bridge.ts, "Request initial ' +
      'data"), on a 5 s poll while printing (state-store.ts startStatusPoll) and on an ' +
      'auto-report gap; the reply replaces StateStore.status wholesale (handleResponse 1002).',
  ],
  [
    1044,
    // A. File list.
    'A: the service sends it on every MQTT registration (mqtt-bridge.ts) and from the ' +
      ":7125 file handling; the reply's file_list replaces StateStore.files.",
  ],
  [
    1046,
    // A. File detail (total layers).
    'A: the service sends it itself when a print starts and when it attaches to a print ' +
      'already running (state-store.ts) — mid-print, where a write would be noticed at ' +
      'once; the reply only sets StateStore.fileTotalLayers.',
  ],
  [
    2005,
    // A. Canvas (multi-spool) info.
    "A: the service sends it on every MQTT registration (mqtt-bridge.ts); the reply's " +
      'canvas_info replaces StateStore.canvas.',
  ],
  [
    1048,
    // B. Storage capacity.
    'B: commit d42d3eb (ELEG-85), written with the protocol reference to hand, records ' +
      'that the reference names 1048 GetCapacity (also in the log-methods.ts comment); the ' +
      'reply carries total/free/used bytes (printer-state.ts case 1048).',
  ],
  [
    1036,
    // B. Print history list.
    'B: printer-state.ts cites CC2_PROTOCOL_REFERENCE.md §1036 for the fields of its reply, ' +
      'and commit 4097497 (ELEG-38) records from the reference that it takes no paging ' +
      'params; the reply is history_task_list. History *delete* is 1038, which stays gated.',
  ],
  [
    1045,
    // C. File thumbnail.
    "C: the reply carries the named file's base64 PNG thumbnail (printer-state.ts case " +
      '1045), and files.ts fires it unprompted for every visible row; README "Protocol ' +
      'Quirks" records its measured parameter behaviour (file_name, error 1003).',
  ],
]);

/**
 * Methods the SPA sends that are deliberately NOT on the list, and why — so that the next
 * person does not add them back from a label. Pinned by the same test.
 */
export const DENIED_BY_DEFAULT: ReadonlyMap<number, string> = new Map([
  [
    2006,
    'Unproven. The SPA sends it on every page load for mono-filament info, but it is absent ' +
      'from the protocol reference and from the firmware method enum (log-methods.ts, ' +
      'ELEG-100), and the reference disagrees with this firmware about the 2006/2007 pair ' +
      '(.agents/testing.md). "The printer answers" proves it exists, not that it writes nothing.',
  ],
  [
    1051,
    'Not a read: a successful reply with no URL starts a timelapse export (main.ts, ' +
      '"Timelapse export started").',
  ],
]);

/** Whether `method` is a proven read. Anything not listed is treated as a write. */
export function isReadMethod(method: number): boolean {
  return READ_METHODS.has(method);
}
