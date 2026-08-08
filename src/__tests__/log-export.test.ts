import { describe, it, expect } from 'vitest';
import { toCaptureFormat, captureFilename } from '../ui/log-export';
import type { LogEntry } from '../log-store';

function entry(over: Partial<LogEntry> = {}): LogEntry {
  return {
    timestamp: 1775469197933,
    direction: 'received',
    topic: 'elegoo/SN/api_status',
    method: 6000,
    payload: '{"truncated":true}',
    raw: { id: 1, method: 6000, result: { extruder: { temperature: 209 } } },
    ...over,
  };
}

describe('toCaptureFormat', () => {
  it('emits the same shape as a server-side capture file', () => {
    // Byte-compatible with data/logs/mqtt-capture-*.json on purpose: ELEG-28 wants
    // fixtures from captured payloads, and a second format would need a converter.
    const [msg] = toCaptureFormat([entry()]);
    expect(Object.keys(msg).sort()).toEqual(['data', 'direction', 'topic', 'ts']);
    expect(msg.direction).toBe('received');
    expect(msg.topic).toBe('elegoo/SN/api_status');
    expect(msg.ts).toBe(1775469197933);
  });

  it('exports the full payload, not the truncated display string', () => {
    // `payload` is capped at 500 chars for rendering and is useless as a fixture.
    const [msg] = toCaptureFormat([entry()]);
    expect(msg.data).toEqual({ id: 1, method: 6000, result: { extruder: { temperature: 209 } } });
    expect(msg.data).not.toBe('{"truncated":true}');
  });

  it('preserves order and count', () => {
    const msgs = toCaptureFormat([
      entry({ timestamp: 1 }),
      entry({ timestamp: 2 }),
      entry({ timestamp: 3 }),
    ]);
    expect(msgs.map((m) => m.ts)).toEqual([1, 2, 3]);
  });

  it('handles an empty list', () => {
    expect(toCaptureFormat([])).toEqual([]);
  });

  it('keeps a sent entry sent', () => {
    expect(toCaptureFormat([entry({ direction: 'sent' })])[0].direction).toBe('sent');
  });
});

describe('captureFilename', () => {
  const at = new Date('2026-08-08T10:11:12.345Z');

  it('names the view so two exports in one session do not collide', () => {
    expect(captureFilename(at, 'raw')).toContain('raw');
    expect(captureFilename(at, 'structured')).toContain('structured');
    expect(captureFilename(at, 'raw')).not.toBe(captureFilename(at, 'structured'));
  });

  it('contains no character Windows rejects in a filename', () => {
    // A browser download is the one place colons in an ISO timestamp reliably bite.
    const name = captureFilename(at, 'raw');
    expect(name).not.toMatch(/[:*?"<>|]/);
    expect(name.endsWith('.json')).toBe(true);
  });

  it('follows the server capture naming convention', () => {
    expect(captureFilename(at, 'raw')).toMatch(/^mqtt-raw-2026-08-08T10-11-12-345Z\.json$/);
  });
});
