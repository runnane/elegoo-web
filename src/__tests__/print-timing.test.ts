import { describe, expect, it } from 'vitest';
import { computePrintTiming } from '../ui/print-timing';

const NOW = Date.UTC(2026, 10, 26, 21, 0, 0);

describe('computePrintTiming (ELEG-169)', () => {
  it('derives the start from total_duration, not print_duration', () => {
    const t = computePrintTiming({ print_duration: 5590, total_duration: 6617 }, NOW);
    expect(t).not.toBeNull();
    expect(t?.elapsedSec).toBe(6617);
    expect(t?.printingSec).toBe(5590);
    expect(t?.startedAt.getTime()).toBe(NOW - 6617 * 1000);
    // 1027 s earlier than the old print_duration-based start
    expect(NOW - 5590 * 1000 - (t?.startedAt.getTime() ?? 0)).toBe(1027 * 1000);
  });

  it('falls back to print_duration when total_duration is missing', () => {
    const t = computePrintTiming({ print_duration: 5590 }, NOW);
    expect(t?.elapsedSec).toBe(5590);
    expect(t?.startedAt.getTime()).toBe(NOW - 5590 * 1000);
  });

  it('falls back to print_duration when total_duration is zero', () => {
    const t = computePrintTiming({ print_duration: 120, total_duration: 0 }, NOW);
    expect(t?.elapsedSec).toBe(120);
    expect(t?.startedAt.getTime()).toBe(NOW - 120 * 1000);
  });

  it('returns null with no durations', () => {
    expect(computePrintTiming({}, NOW)).toBeNull();
    expect(computePrintTiming(undefined, NOW)).toBeNull();
  });
});
