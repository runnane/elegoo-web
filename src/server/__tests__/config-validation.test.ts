import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';

/**
 * Pins the rest of `loadConfig`'s refusals — ELEG-92, slice 3 of ELEG-28.
 *
 * `config-defaults.test.ts` already covers the AI defaults and PRINTER_IP (required,
 * malformed, no private fallback) — not repeated here. A sibling PR (ELEG-93, #107) is
 * adding BIND_ADDRESS validation and refactoring the IPv4 check into a shared helper
 * that changes PRINTER_IP's message wording, so this file deliberately does not test
 * BIND_ADDRESS or assert on PRINTER_IP's message text.
 *
 * Remaining refusals pinned here, each with an accepting control next to it so a test
 * cannot pass because loadConfig threw for an unrelated reason:
 *   - SERVICE_PORT out of range, and non-numeric
 *   - MOONRAKER_PORT out of range, and non-numeric
 *   - TELEGRAM_CHAT_ID non-numeric
 *   - TELEGRAM_ALLOWED_CHAT_IDS that parses to nothing
 *   - PRINTER_IP well-formed but with an octet above 255 (ELEG-103) — the one PRINTER_IP
 *     refusal config-defaults.test.ts does not pin. It matches on the variable name and
 *     the word "octet", not the full message, so the shared-validator refactor (ELEG-106)
 *     can reword it without touching this file.
 *
 * Same env save/restore pattern as config-defaults.test.ts: loadConfig() reads
 * process.env directly, so tests swap the whole object rather than mutating keys.
 */

const ORIGINAL = process.env;

beforeEach(() => {
  // A minimal environment: only what loadConfig() refuses to start without.
  process.env = { PRINTER_IP: '192.0.2.10' } as NodeJS.ProcessEnv;
});

afterEach(() => {
  process.env = ORIGINAL;
});

describe('SERVICE_PORT validation', () => {
  it('refuses a port below 1', () => {
    process.env.SERVICE_PORT = '0';
    expect(() => loadConfig()).toThrow(/SERVICE_PORT/);
  });

  it('refuses a port above 65535', () => {
    process.env.SERVICE_PORT = '65536';
    expect(() => loadConfig()).toThrow(/SERVICE_PORT/);
  });

  it('refuses a non-numeric value', () => {
    process.env.SERVICE_PORT = 'not-a-port';
    expect(() => loadConfig()).toThrow(/SERVICE_PORT/);
  });

  it('accepts a valid port', () => {
    process.env.SERVICE_PORT = '9000';
    expect(loadConfig().servicePort).toBe(9000);
  });
});

describe('MOONRAKER_PORT validation', () => {
  it('refuses a port below 1', () => {
    process.env.MOONRAKER_PORT = '0';
    expect(() => loadConfig()).toThrow(/MOONRAKER_PORT/);
  });

  it('refuses a port above 65535', () => {
    process.env.MOONRAKER_PORT = '65536';
    expect(() => loadConfig()).toThrow(/MOONRAKER_PORT/);
  });

  it('refuses a non-numeric value', () => {
    process.env.MOONRAKER_PORT = 'not-a-port';
    expect(() => loadConfig()).toThrow(/MOONRAKER_PORT/);
  });

  it('accepts a valid port', () => {
    process.env.MOONRAKER_PORT = '7200';
    expect(loadConfig().moonrakerPort).toBe(7200);
  });
});

describe('TELEGRAM_CHAT_ID validation', () => {
  it('refuses a non-numeric chat id', () => {
    process.env.TELEGRAM_CHAT_ID = 'not-a-chat-id';
    expect(() => loadConfig()).toThrow(/TELEGRAM_CHAT_ID/);
  });

  it('accepts a numeric chat id', () => {
    process.env.TELEGRAM_CHAT_ID = '900000001';
    expect(loadConfig().telegramChatId).toBe('900000001');
  });

  it('accepts a negative (channel) chat id', () => {
    process.env.TELEGRAM_CHAT_ID = '-900000001';
    expect(loadConfig().telegramChatId).toBe('-900000001');
  });
});

describe('TELEGRAM_ALLOWED_CHAT_IDS validation', () => {
  it('refuses a list that parses to no valid numeric id', () => {
    process.env.TELEGRAM_ALLOWED_CHAT_IDS = 'not,valid,ids';
    expect(() => loadConfig()).toThrow(/TELEGRAM_ALLOWED_CHAT_IDS/);
  });

  it('accepts a valid comma-separated list', () => {
    process.env.TELEGRAM_ALLOWED_CHAT_IDS = '900000001,900000002';
    expect(loadConfig().telegramAllowedChatIds).toEqual(['900000001', '900000002']);
  });
});

describe('PRINTER_IP octet range (ELEG-103)', () => {
  // These pass the dotted-quad regex, so only the per-octet check can refuse them. The
  // /octet/ match is what pins *that* branch rather than the malformed-address one.
  it('refuses an address whose first octet is above 255', () => {
    process.env.PRINTER_IP = '999.1.1.1';
    expect(() => loadConfig()).toThrow(/PRINTER_IP/);
    expect(() => loadConfig()).toThrow(/octet/);
  });

  it('refuses an address whose last octet is above 255', () => {
    process.env.PRINTER_IP = '192.168.1.999';
    expect(() => loadConfig()).toThrow(/PRINTER_IP/);
    expect(() => loadConfig()).toThrow(/octet/);
  });

  it('accepts 255 as an octet (the boundary, TEST-NET)', () => {
    process.env.PRINTER_IP = '192.0.2.255';
    expect(loadConfig().printerIp).toBe('192.0.2.255');
  });
});
