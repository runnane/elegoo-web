// @vitest-environment jsdom
/**
 * ELEG-162 — 1036 `task_status` codes, pinned to the vendor web app's labels
 * (`0 Other, 1 Complete, 2 Cancel, 3 Cancel, 4 Printing, 5 Pause`). The expected values
 * are written out here, not derived from the implementation, so the two cannot drift
 * together. jsdom because print-history.ts is a DOM module (the display table lives
 * there).
 */

import { describe, expect, it } from 'vitest';
import { mapTaskStatus } from '../printer-state';
import { HISTORY_STATUS } from '../ui/print-history';

describe('mapTaskStatus', () => {
  it.each([
    [1, 'completed'],
    [2, 'stopped'],
    [3, 'stopped'],
    [4, 'printing'],
    [5, 'paused'],
    [0, 'unknown'],
    [99, 'unknown'],
    [undefined, 'unknown'],
  ] as const)('task_status %s → %s', (code, expected) => {
    expect(mapTaskStatus(code)).toBe(expected);
  });

  it('passes a string status through untouched', () => {
    expect(mapTaskStatus('completed')).toBe('completed');
  });
});

describe('history display table', () => {
  it('has an icon and a filter option for every status mapTaskStatus produces', () => {
    for (const code of [0, 1, 2, 3, 4, 5]) {
      const status = mapTaskStatus(code);
      expect(HISTORY_STATUS[status], `task_status ${code} → ${status}`).toBeDefined();
    }
  });

  it('labels the vendor codes the way the vendor app does', () => {
    expect(HISTORY_STATUS[mapTaskStatus(1)].label).toBe('completed');
    expect(HISTORY_STATUS[mapTaskStatus(2)].label).toBe('cancelled');
    expect(HISTORY_STATUS[mapTaskStatus(4)].label).toBe('printing');
    expect(HISTORY_STATUS[mapTaskStatus(5)].label).toBe('paused');
  });
});
