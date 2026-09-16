import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ELEG-84 (building on ELEG-46's same seam). `maybeNotifyForEvent` must only ever be
 * called from the LIVE event path (`onEventLog`), never from `loadEventLogHistory`
 * (events restored on reconnect) — a burst of desktop notifications for prints that
 * finished hours ago would be considerably worse than the audio equivalent, because a
 * notification persists on screen after it fires rather than playing once and ending.
 *
 * `main.ts` wires a WebSocket client and browser globals imperatively and is not
 * otherwise unit-testable (no DOM/WS harness exists for it in this repo), so this
 * asserts the invariant structurally: read the source, isolate the `onEventLog` handler
 * body and the `loadEventLogHistory` call site, and check which one calls the notifier.
 */
describe('main.ts live-vs-history wiring for maybeNotifyForEvent (ELEG-84)', () => {
  const source = readFileSync(join(__dirname, '../main.ts'), 'utf8');

  it('calls maybeNotifyForEvent (and maybeAlertForEvent) from the live onEventLog handler', () => {
    const start = source.indexOf('onEventLog(entry) {');
    const end = source.indexOf('onLayerTime(entry)', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const block = source.slice(start, end);
    expect(block).toContain('maybeNotifyForEvent(entry.event)');
    expect(block).toContain('maybeAlertForEvent(entry.event)');
  });

  it('never calls maybeNotifyForEvent from the loadEventLogHistory (restored-on-connect) path', () => {
    const start = source.indexOf('loadEventLogHistory(');
    const end = source.indexOf('showDashboard();', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const block = source.slice(start, end);
    expect(block).not.toContain('maybeNotifyForEvent');
    expect(block).not.toContain('maybeAlertForEvent');
  });
});
