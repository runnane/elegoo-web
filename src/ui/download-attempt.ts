/**
 * Retry-or-fail for one attempt at the gcode download proxy (ELEG-200). Pure, so a
 * test can reach it; `loadGcode` in gcode-preview.ts does the fetching.
 *
 * Only a network-level failure (the fetch itself threw, or our own abort fired) is
 * worth retrying. A non-ok response means the service already waited out its own
 * bound on the printer — mid-print the printer holds every download open for ~75 s
 * and then closes it — so a retry is just another wait, and the service's message
 * is the thing to show.
 */
export type DownloadAttempt =
  | { kind: 'ok'; text: string }
  | { kind: 'network'; error: Error }
  | { kind: 'status'; status: number; body: string | null }
  | { kind: 'bodyError' };

export type DownloadDecision =
  | { action: 'done'; text: string }
  | { action: 'retry' }
  | { action: 'fail'; message: string };

export const BODY_STALL_MESSAGE =
  'The printer did not deliver the file (the download stalled or was cut off). ' +
  'It may refuse file downloads while printing — try again when the print has finished.';

/** The `error` field of a JSON error body, if there is one. */
function serverError(body: string | null): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed.error === 'string' && parsed.error ? parsed.error : null;
  } catch {
    return null;
  }
}

export function decideDownloadAttempt(
  attempt: DownloadAttempt,
  attemptNo: number,
  maxAttempts: number,
): DownloadDecision {
  switch (attempt.kind) {
    case 'ok':
      return { action: 'done', text: attempt.text };
    case 'bodyError':
      return { action: 'fail', message: BODY_STALL_MESSAGE };
    case 'status': {
      const msg = serverError(attempt.body);
      return {
        action: 'fail',
        message: msg ?? `Download failed: HTTP ${attempt.status}`,
      };
    }
    case 'network':
      if (attemptNo < maxAttempts) return { action: 'retry' };
      return { action: 'fail', message: `Download failed: ${attempt.error.message}` };
  }
}
