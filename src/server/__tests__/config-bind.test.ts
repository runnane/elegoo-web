import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';

/**
 * `BIND_ADDRESS` (ELEG-93) — the interface both HTTP servers listen on. Pinned the same
 * way `PRINTER_IP` is in `config-defaults.test.ts`: a minimal environment swapped in
 * wholesale, so a stray value inherited from the developer's shell cannot pass or fail
 * these for the wrong reason.
 *
 * `config-validation.test.ts` (ELEG-92, a sibling slice) covers other `loadConfig`
 * refusals; this file is scoped to `BIND_ADDRESS` only, per the issue.
 */

const ORIGINAL = process.env;

beforeEach(() => {
  process.env = { PRINTER_IP: '192.0.2.10' } as NodeJS.ProcessEnv;
});

afterEach(() => {
  process.env = ORIGINAL;
});

describe('BIND_ADDRESS', () => {
  it('defaults to 0.0.0.0 — no behaviour change for an existing deployment', () => {
    expect(loadConfig().bindAddress).toBe('0.0.0.0');
  });

  it('accepts an explicit 0.0.0.0', () => {
    process.env.BIND_ADDRESS = '0.0.0.0';
    expect(loadConfig().bindAddress).toBe('0.0.0.0');
  });

  it('accepts loopback', () => {
    process.env.BIND_ADDRESS = '127.0.0.1';
    expect(loadConfig().bindAddress).toBe('127.0.0.1');
  });

  it('accepts an arbitrary valid IPv4 address', () => {
    process.env.BIND_ADDRESS = '192.0.2.50';
    expect(loadConfig().bindAddress).toBe('192.0.2.50');
  });

  it('refuses a malformed value rather than passing it to listen() unchecked', () => {
    process.env.BIND_ADDRESS = 'not-an-address';
    expect(() => loadConfig()).toThrow(/BIND_ADDRESS/);
  });

  it('refuses an out-of-range octet', () => {
    process.env.BIND_ADDRESS = '999.0.0.1';
    expect(() => loadConfig()).toThrow(/BIND_ADDRESS/);
  });

  it('refuses IPv6 explicitly rather than silently mis-binding', () => {
    // IPv6 is out of scope for this issue (see config.ts). The refusal message should
    // say so rather than just "invalid", since a user reaching for "::" has a specific
    // and reasonable expectation this repo does not support yet.
    process.env.BIND_ADDRESS = '::';
    expect(() => loadConfig()).toThrow(/IPv6/);
  });

  it('refuses an empty explicit value rather than silently falling back', () => {
    process.env.BIND_ADDRESS = '';
    // env() treats an empty string as unset and falls back to the default — assert
    // that documented behaviour explicitly, since it is easy to assume the opposite.
    expect(loadConfig().bindAddress).toBe('0.0.0.0');
  });
});
