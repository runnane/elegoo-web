/**
 * ELEG-200: the preview retried a non-ok download response with no status and no
 * delay, threw the service's error body away, and ended on "Download failed: no
 * response" after three ~75 s waits on a printer that will not serve files mid-print.
 */
import { describe, expect, it } from 'vitest';
import { BODY_STALL_MESSAGE, decideDownloadAttempt } from '../ui/download-attempt';

describe('decideDownloadAttempt (ELEG-200)', () => {
  it('fails at once on a non-ok response and shows the service message', () => {
    const body = JSON.stringify({
      error: 'The printer closed the download without sending the file.',
    });
    expect(decideDownloadAttempt({ kind: 'status', status: 502, body }, 1, 3)).toEqual({
      action: 'fail',
      message: 'The printer closed the download without sending the file.',
    });
  });

  it('falls back to the HTTP status when the body has no error field', () => {
    expect(decideDownloadAttempt({ kind: 'status', status: 504, body: 'not json' }, 1, 3)).toEqual({
      action: 'fail',
      message: 'Download failed: HTTP 504',
    });
    expect(decideDownloadAttempt({ kind: 'status', status: 500, body: null }, 1, 3)).toEqual({
      action: 'fail',
      message: 'Download failed: HTTP 500',
    });
  });

  it('retries a network-level failure until the last attempt, then fails with its message', () => {
    const error = new Error('Failed to fetch');
    expect(decideDownloadAttempt({ kind: 'network', error }, 1, 3)).toEqual({ action: 'retry' });
    expect(decideDownloadAttempt({ kind: 'network', error }, 2, 3)).toEqual({ action: 'retry' });
    expect(decideDownloadAttempt({ kind: 'network', error }, 3, 3)).toEqual({
      action: 'fail',
      message: 'Download failed: Failed to fetch',
    });
  });

  it('does not retry a body that stalled after the headers', () => {
    expect(decideDownloadAttempt({ kind: 'bodyError' }, 1, 3)).toEqual({
      action: 'fail',
      message: BODY_STALL_MESSAGE,
    });
  });

  it('hands back the text of a good download', () => {
    expect(decideDownloadAttempt({ kind: 'ok', text: 'G1 X0\n' }, 1, 3)).toEqual({
      action: 'done',
      text: 'G1 X0\n',
    });
  });
});
