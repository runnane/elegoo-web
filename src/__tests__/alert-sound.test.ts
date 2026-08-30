import { describe, expect, it } from 'vitest';
import { alertForEvent } from '../ui/alert-sound';
import { CRITICAL_EXCEPTIONS } from '../types';

/**
 * ELEG-46. Only the decision half is testable — whether a sound actually reaches
 * speakers needs a browser, a user gesture and an `AudioContext`, and no gate here has
 * any of those. What IS testable is which events should sound, and that is where the
 * rules that could silently drift live.
 */
describe('alertForEvent', () => {
  it('sounds a success for a completed print', () => {
    expect(alertForEvent({ type: 'print_completed', filename: 'a.gcode' })).toBe('success');
  });

  it('sounds a failure for a failed print', () => {
    expect(alertForEvent({ type: 'print_failed', filename: 'a.gcode', reason: 'x' })).toBe(
      'failure',
    );
  });

  it('sounds a failure for an error carrying a critical exception code', () => {
    // 101 is in CRITICAL_EXCEPTIONS; asserted below so this cannot drift silently.
    expect(CRITICAL_EXCEPTIONS.has(101)).toBe(true);
    expect(alertForEvent({ type: 'error', codes: [101], names: ['Nozzle temp abnormal'] })).toBe(
      'failure',
    );
  });

  it('stays silent for an error whose codes are all non-critical', () => {
    // 9999 is deliberately not a real exception; asserted so the test cannot pass
    // merely because the set happened to change.
    expect(CRITICAL_EXCEPTIONS.has(9999)).toBe(false);
    expect(alertForEvent({ type: 'error', codes: [9999], names: ['Something minor'] })).toBeNull();
  });

  it('sounds if any one code in a mixed batch is critical', () => {
    expect(alertForEvent({ type: 'error', codes: [9999, 801], names: [] })).toBe('failure');
  });

  it('reuses CRITICAL_EXCEPTIONS rather than a second severity list', () => {
    // The issue is explicit that a second severity rule must not be invented. This
    // asserts the coupling directly: every critical code produces a failure alert.
    for (const code of CRITICAL_EXCEPTIONS) {
      expect(alertForEvent({ type: 'error', codes: [code], names: [] })).toBe('failure');
    }
  });

  it('stays silent for routine events', () => {
    for (const type of [
      'connected',
      'disconnected',
      'print_started',
      'print_progress',
      'layer_change',
      'first_layer_complete',
      'status_change',
      'sub_status_change',
    ]) {
      expect(alertForEvent({ type })).toBeNull();
    }
  });

  it('stays silent rather than throwing when an error event has no codes array', () => {
    // Defensive: the field is typed on the server, but this runs on whatever the socket
    // delivered, and a throw here would break the event log render.
    expect(alertForEvent({ type: 'error', names: ['x'] })).toBeNull();
    expect(alertForEvent({ type: 'error', codes: 'not-an-array' })).toBeNull();
  });

  it('stays silent for an unknown event type', () => {
    expect(alertForEvent({ type: 'something_new' })).toBeNull();
    expect(alertForEvent({})).toBeNull();
  });
});
