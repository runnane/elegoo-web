import { describe, expect, it } from 'vitest';
import { formatRelative } from '../ui/relative-time';

/**
 * ELEG-45. The formatting is pure and `now` is a parameter, so the boundaries are
 * directly assertable — and the boundaries are exactly where these read wrong.
 *
 * Every case is expressed as an offset from a fixed `NOW` so the arithmetic is visible
 * in the test rather than hidden in a literal.
 */
const NOW = 1_700_000_000_000;
const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;

/** `n` units ago, as an absolute timestamp. */
const ago = (ms: number) => NOW - ms;

describe('formatRelative', () => {
  it('says "just now" for anything under ten seconds', () => {
    expect(formatRelative(ago(0), NOW)).toBe('just now');
    expect(formatRelative(ago(9 * S), NOW)).toBe('just now');
  });

  it('switches to seconds exactly at ten seconds', () => {
    expect(formatRelative(ago(10 * S), NOW)).toBe('10s ago');
  });

  it('holds seconds right up to the minute boundary', () => {
    // The 59s/60s boundary the issue calls out.
    expect(formatRelative(ago(59 * S), NOW)).toBe('59s ago');
    expect(formatRelative(ago(60 * S), NOW)).toBe('1m ago');
  });

  it('rounds down rather than up within a minute', () => {
    // 119s is 1m59s. Reporting "2m ago" would claim more time has passed than has.
    expect(formatRelative(ago(119 * S), NOW)).toBe('1m ago');
    expect(formatRelative(ago(120 * S), NOW)).toBe('2m ago');
  });

  it('holds minutes right up to the hour boundary', () => {
    expect(formatRelative(ago(59 * M), NOW)).toBe('59m ago');
    expect(formatRelative(ago(60 * M), NOW)).toBe('1h ago');
  });

  it('reports 90 minutes as one hour, not ninety minutes', () => {
    // The other boundary the issue names explicitly.
    expect(formatRelative(ago(90 * M), NOW)).toBe('1h ago');
  });

  it('holds hours right up to the day boundary', () => {
    expect(formatRelative(ago(23 * H), NOW)).toBe('23h ago');
    expect(formatRelative(ago(24 * H), NOW)).toBe('1d ago');
  });

  it('reports days beyond that', () => {
    expect(formatRelative(ago(3 * D), NOW)).toBe('3d ago');
    expect(formatRelative(ago(400 * D), NOW)).toBe('400d ago');
  });

  it('reads a future timestamp as "just now" rather than a negative age', () => {
    // Clock skew between the service and the browser is real; "-3s ago" is nonsense
    // and "in 3 seconds" is not worth the complexity for a log line.
    expect(formatRelative(NOW + 5 * S, NOW)).toBe('just now');
    expect(formatRelative(NOW + 60 * M, NOW)).toBe('just now');
  });
});
