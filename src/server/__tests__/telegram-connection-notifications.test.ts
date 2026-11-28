/**
 * ELEG-189 (from PR #158): `TELEGRAM_CONNECTION_NOTIFICATIONS=false` mutes the
 * connected/disconnected messages and nothing else. `handleEvent` returns early on
 * exactly this predicate; nothing in the repo can stand up a grammy bot, so the
 * predicate is what is asserted, in both directions.
 */
import { describe, expect, it } from 'vitest';
import { isMutedConnectionEvent } from '../telegram.js';

describe('isMutedConnectionEvent', () => {
  it('mutes connected and disconnected when connection notifications are off', () => {
    expect(isMutedConnectionEvent('connected', false)).toBe(true);
    expect(isMutedConnectionEvent('disconnected', false)).toBe(true);
  });

  it('never mutes a print event, even with connection notifications off', () => {
    for (const type of [
      'print_started',
      'print_completed',
      'print_failed',
      'print_progress',
      'error',
      'filament_runout',
    ] as const) {
      expect(isMutedConnectionEvent(type, false), type).toBe(false);
    }
  });

  it('mutes nothing when connection notifications are on (the default)', () => {
    expect(isMutedConnectionEvent('connected', true)).toBe(false);
    expect(isMutedConnectionEvent('disconnected', true)).toBe(false);
  });
});
