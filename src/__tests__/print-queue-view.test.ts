/**
 * Print queue card — the pure half (ELEG-35). Node environment; no DOM.
 *
 * The button state is advice, not the guard (the service refuses the same cases), but a
 * card that offers "Start next" while a print is running invites exactly the click the
 * queue exists to prevent — so the disabled cases are pinned here.
 */

import { describe, expect, it } from 'vitest';
import { BED_CLEAR_REMINDER, type QueueSnapshot } from '../print-queue-shared';
import { baseName, queueRows, startNextView } from '../ui/print-queue-view';

function snapshot(partial: Partial<QueueSnapshot> = {}): QueueSnapshot {
  return {
    items: [
      { id: 'a', filename: 'plates/fixture-a.gcode', source: 'local', addedAt: 1 },
      { id: 'b', filename: 'fixture-b.gcode', source: 'u-disk', addedAt: 2 },
    ],
    active: null,
    hold: null,
    lastFinished: null,
    ...partial,
  };
}

describe('baseName', () => {
  it('takes the last path segment', () => {
    expect(baseName('plates/fixture-a.gcode')).toBe('fixture-a.gcode');
    expect(baseName('fixture-b.gcode')).toBe('fixture-b.gcode');
  });
});

describe('startNextView', () => {
  it('is enabled when idle, and always reminds the user to clear the bed', () => {
    const view = startNextView(snapshot(), 1, 0);
    expect(view.enabled).toBe(true);
    expect(view.hint).toContain(BED_CLEAR_REMINDER);
    expect(view.hint).toContain('fixture-a.gcode');
  });

  it('names the job that just finished', () => {
    const view = startNextView(
      snapshot({ lastFinished: { filename: 'plates/fixture-z.gcode', at: 3 } }),
      1,
      2077,
    );
    expect(view.enabled).toBe(true);
    expect(view.hint).toContain('"fixture-z.gcode" finished');
    expect(view.hint).toContain(BED_CLEAR_REMINDER);
  });

  it('is disabled while printing', () => {
    expect(startNextView(snapshot(), 2, 0)).toMatchObject({ enabled: false });
  });

  it('is disabled while paused', () => {
    const view = startNextView(snapshot(), 2, 2502);
    expect(view.enabled).toBe(false);
    expect(view.hint).toContain('paused');
  });

  it('is disabled and flagged while the queue is held, showing the reason', () => {
    const view = startNextView(snapshot({ hold: { reason: 'fixture failed.', at: 3 } }), 1, 0);
    expect(view).toMatchObject({ enabled: false, warning: true });
    expect(view.hint).toContain('fixture failed.');
  });

  it('is disabled while a queued job is out', () => {
    const active = { item: snapshot().items[0], dispatchedAt: 3, started: true };
    expect(startNextView(snapshot({ active }), 1, 0)).toMatchObject({ enabled: false });
  });

  it('is disabled for an empty or not-yet-loaded queue', () => {
    expect(startNextView(snapshot({ items: [] }), 1, 0).enabled).toBe(false);
    expect(startNextView(null, 1, 0).enabled).toBe(false);
  });
});

describe('queueRows', () => {
  it('numbers rows and says which can move', () => {
    const rows = queueRows(snapshot());
    expect(rows.map((r) => [r.position, r.name, r.source, r.canMoveUp, r.canMoveDown])).toEqual([
      [1, 'fixture-a.gcode', 'Local', false, true],
      [2, 'fixture-b.gcode', 'USB', true, false],
    ]);
    expect(queueRows(null)).toEqual([]);
  });
});
