/**
 * ELEG-139: the transport-neutral half of write auth (`write-auth.ts`) and the
 * `SERVICE_API_KEY` validation in `config.ts`. The router-level proof is in
 * `api-write-auth.test.ts`; this pins the pieces ELEG-140..143 will reuse.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { describe, expect, it, vi } from 'vitest';
import { parseServiceApiKey } from '../server/config.js';
import { authorize, checkKey, extractKey, guardHttp } from '../server/write-auth.js';

const KEY = 'a'.repeat(20) + 'bcdefghijklmnop'; // 35 chars, generated

const req = (headers: Record<string, string | string[]>) =>
  ({ headers }) as unknown as IncomingMessage;

describe('extractKey', () => {
  it('reads Authorization: Bearer', () => {
    expect(extractKey(req({ authorization: `Bearer ${KEY}` }))).toBe(KEY);
  });

  it('reads X-Api-Key', () => {
    expect(extractKey(req({ 'x-api-key': KEY }))).toBe(KEY);
  });

  it('prefers Bearer over X-Api-Key', () => {
    expect(extractKey(req({ authorization: 'Bearer one', 'x-api-key': 'two' }))).toBe('one');
  });

  it('is null when nothing is presented', () => {
    expect(extractKey(req({}))).toBeNull();
  });

  it('treats a Basic header (a proxy doing its own auth) as absent, not as a wrong key', () => {
    expect(extractKey(req({ authorization: 'Basic dXNlcjpwYXNz' }))).toBeNull();
  });

  it('treats bare "Bearer" (an empty value, as it arrives over the wire) as presented and empty', () => {
    expect(extractKey(req({ authorization: 'Bearer' }))).toBe('');
    expect(extractKey(req({ authorization: 'Bearer ' }))).toBe('');
  });

  it('never trims: a trailing space stays part of the presented value', () => {
    expect(extractKey(req({ authorization: `Bearer ${KEY} ` }))).toBe(`${KEY} `);
    expect(extractKey(req({ 'x-api-key': `${KEY} ` }))).toBe(`${KEY} `);
  });
});

describe('checkKey', () => {
  it('matches the same key', () => {
    expect(checkKey(KEY, KEY)).toBe(true);
  });

  it.each([
    ['a different key', 'b'.repeat(35)],
    ['a prefix', KEY.slice(0, 10)],
    ['the key plus a trailing space', `${KEY} `],
    ['empty', ''],
  ])('rejects %s', (_label, presented) => {
    expect(checkKey(presented, KEY)).toBe(false);
  });

  it('never matches when no key is configured — two empty strings must not authenticate', () => {
    expect(checkKey('', '')).toBe(false);
  });
});

describe('authorize', () => {
  it('allows everything when no key is configured', () => {
    expect(authorize('', null, true)).toBe('ok');
    expect(authorize('', 'anything', true)).toBe('ok');
  });

  it('refuses a write with no key as missing, and allows a read', () => {
    expect(authorize(KEY, null, true)).toBe('missing');
    expect(authorize(KEY, null, false)).toBe('ok');
  });

  it('refuses a wrong key as invalid on reads and writes alike', () => {
    expect(authorize(KEY, 'nope', true)).toBe('invalid');
    expect(authorize(KEY, 'nope', false)).toBe('invalid');
    expect(authorize(KEY, '', false)).toBe('invalid');
  });

  it('allows the right key', () => {
    expect(authorize(KEY, KEY, true)).toBe('ok');
  });
});

describe('guardHttp', () => {
  function fakeRes() {
    const res = { writeHead: vi.fn(), end: vi.fn() };
    return res as typeof res & ServerResponse;
  }

  it('answers 401 for a header that really carries the trailing space, and never echoes the key', () => {
    const res = fakeRes();
    const proceed = guardHttp(req({ authorization: `Bearer ${KEY} ` }), res, KEY, true);
    expect(proceed).toBe(false);
    expect(res.writeHead).toHaveBeenCalledWith(401, expect.anything());
    const body = String(res.end.mock.calls[0][0]);
    expect(body).not.toContain(KEY.slice(0, 8));
  });

  it('lets the right key through without writing a response', () => {
    const res = fakeRes();
    expect(guardHttp(req({ 'x-api-key': KEY }), res, KEY, true)).toBe(true);
    expect(res.writeHead).not.toHaveBeenCalled();
  });
});

describe('parseServiceApiKey', () => {
  it('unset or empty means disabled', () => {
    expect(parseServiceApiKey(undefined)).toBe('');
    expect(parseServiceApiKey('')).toBe('');
  });

  it('accepts a key of 32+ characters', () => {
    expect(parseServiceApiKey('z'.repeat(32))).toBe('z'.repeat(32));
  });

  it('throws on a key shorter than 32 characters, without quoting it', () => {
    const short = 'secretsecret31charslongXXXXXXXX'.slice(0, 31);
    expect(() => parseServiceApiKey(short)).toThrow(/shorter than 32/);
    try {
      parseServiceApiKey(short);
    } catch (e) {
      expect((e as Error).message).not.toContain(short);
    }
  });

  it('throws on surrounding whitespace, which no HTTP client could ever present', () => {
    expect(() => parseServiceApiKey(` ${'z'.repeat(32)}`)).toThrow(/whitespace/);
    expect(() => parseServiceApiKey(`${'z'.repeat(32)} `)).toThrow(/whitespace/);
  });
});
