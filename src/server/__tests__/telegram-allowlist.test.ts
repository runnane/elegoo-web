/**
 * Telegram sender allowlist (ELEG-3).
 *
 * The bot registered `/start`, `/help`, `/status` and `/photo` with no check on who sent
 * the message. `TELEGRAM_CHAT_ID` was only ever used for *outbound* notifications, so
 * inbound was open to anyone who found the bot — printer status, and via `/photo` a live
 * camera image of the room.
 *
 * This is a security boundary, so it is asserted in **both** directions: that an allowed
 * id passes, and that everything else is refused. The middleware wiring in
 * `src/server/telegram.ts` is not covered — nothing in this repo can stand up a grammy
 * bot — so the `next()`-only-when-allowed shape is verified by reading. What is covered
 * is every way the decision itself can go wrong.
 */

import { describe, it, expect } from 'vitest';
import { isAllowedSender, parseAllowedChatIds } from '../allowlist.js';

describe('parseAllowedChatIds', () => {
  it('falls back to TELEGRAM_CHAT_ID when no explicit list is set', () => {
    expect(parseAllowedChatIds(undefined, '12345')).toEqual(['12345']);
    expect(parseAllowedChatIds('', '12345')).toEqual(['12345']);
    expect(parseAllowedChatIds('   ', '12345')).toEqual(['12345']);
  });

  it('parses a comma-separated list, tolerating whitespace', () => {
    expect(parseAllowedChatIds(' 111 , 222,333 ', '999')).toEqual(['111', '222', '333']);
  });

  it('keeps negative ids — a Telegram channel id is negative', () => {
    expect(parseAllowedChatIds('-1001234567890', '')).toEqual(['-1001234567890']);
  });

  it('keeps ids beyond Number.MAX_SAFE_INTEGER intact', () => {
    // Parsing these as numbers would round them and let a near-miss id through.
    const huge = '99999999999999999999';
    expect(parseAllowedChatIds(huge, '')).toEqual([huge]);
  });

  it('drops malformed entries rather than widening the gate', () => {
    expect(parseAllowedChatIds('111,notanid,,222, 1.5 ,0x10', '')).toEqual(['111', '222']);
  });

  it('deduplicates', () => {
    expect(parseAllowedChatIds('111,111,222', '')).toEqual(['111', '222']);
  });

  it('returns empty when there is nothing usable at all', () => {
    expect(parseAllowedChatIds(undefined, '')).toEqual([]);
    expect(parseAllowedChatIds('garbage', '')).toEqual([]);
  });
});

describe('isAllowedSender', () => {
  const allowed = parseAllowedChatIds('111,-1002', '');

  it('admits an id on the list', () => {
    expect(isAllowedSender(allowed, 111)).toBe(true);
    expect(isAllowedSender(allowed, -1002)).toBe(true);
  });

  it('refuses an id that is not on the list', () => {
    expect(isAllowedSender(allowed, 112)).toBe(false);
    expect(isAllowedSender(allowed, 1)).toBe(false);
    expect(isAllowedSender(allowed, -111)).toBe(false);
  });

  it('refuses an update with no sender', () => {
    // ctx.from is optional in grammy — channel posts have none.
    expect(isAllowedSender(allowed, undefined)).toBe(false);
  });

  it('denies everyone when the allowlist is empty', () => {
    // The safe direction. Treating empty as "allow all" would turn a missing env var
    // back into the hole this closes.
    expect(isAllowedSender([], 111)).toBe(false);
    expect(isAllowedSender([], undefined)).toBe(false);
  });

  it('does not match on a prefix or a substring', () => {
    expect(isAllowedSender(['1234'], 123)).toBe(false);
    expect(isAllowedSender(['1234'], 12345)).toBe(false);
  });
});
