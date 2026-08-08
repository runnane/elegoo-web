import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readCachedSn, writeCachedSn, isValidSn, snCachePath } from '../sn-cache.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sn-cache-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const REAL_SN = 'F01U3UD3798YT8K';

describe('isValidSn', () => {
  it('accepts a real CC2 serial', () => {
    expect(isValidSn(REAL_SN)).toBe(true);
  });

  it('rejects anything with MQTT topic metacharacters', () => {
    // The SN is interpolated straight into topic filters. A stray `#` would subscribe
    // to the whole broker; a `/` would silently address the wrong topic level.
    for (const bad of ['#', 'F01/#', 'a/b', 'sn#', '+', 'a+b']) {
      expect(isValidSn(bad), `${bad} must be rejected`).toBe(false);
    }
  });

  it('rejects empty, short and non-string values', () => {
    for (const bad of ['', 'ab', null, undefined, 42, {}, []]) {
      expect(isValidSn(bad)).toBe(false);
    }
  });
});

describe('readCachedSn', () => {
  it('returns empty when no cache exists, which is a normal first start', () => {
    expect(readCachedSn(dir)).toBe('');
  });

  it('round-trips a written SN', () => {
    writeCachedSn(dir, REAL_SN);
    expect(readCachedSn(dir)).toBe(REAL_SN);
  });

  it('returns empty rather than throwing on malformed JSON', () => {
    writeFileSync(snCachePath(dir), 'not json at all', 'utf-8');
    expect(readCachedSn(dir)).toBe('');
  });

  it('returns empty for the wrong shape', () => {
    for (const body of ['{}', '[]', 'null', '{"sn": 42}', '{"serial":"X"}']) {
      writeFileSync(snCachePath(dir), body, 'utf-8');
      expect(readCachedSn(dir), body).toBe('');
    }
  });

  it('refuses a cached SN that would poison a topic filter', () => {
    // A hand-edited or corrupt file must not reach the subscribe call.
    writeFileSync(snCachePath(dir), JSON.stringify({ sn: 'F01/#' }), 'utf-8');
    expect(readCachedSn(dir)).toBe('');
  });
});

describe('writeCachedSn', () => {
  it('does not write an invalid SN', () => {
    writeCachedSn(dir, 'a/b');
    expect(readCachedSn(dir)).toBe('');
  });

  it('overwrites a previous SN, so swapping printers settles', () => {
    writeCachedSn(dir, REAL_SN);
    writeCachedSn(dir, 'F02NEWPRINTER01');
    expect(readCachedSn(dir)).toBe('F02NEWPRINTER01');
  });

  it('stores it under an `sn` key, which is what readCachedSn expects', () => {
    writeCachedSn(dir, REAL_SN);
    expect(JSON.parse(readFileSync(snCachePath(dir), 'utf-8'))).toEqual({ sn: REAL_SN });
  });

  it('does not throw when the directory does not exist', () => {
    // A read-only or missing data dir must cost one discovery cycle, never a crash.
    expect(() => writeCachedSn(join(dir, 'nope'), REAL_SN)).not.toThrow();
  });
});
