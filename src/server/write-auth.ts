/**
 * Write authentication: one shared key, `SERVICE_API_KEY` (ELEG-25, ELEG-139).
 *
 * The rule, for every surface that adopts it:
 *
 *   - **Key unset** → everything is allowed. That is the behaviour before this existed,
 *     and `index.ts` warns loudly at startup. Failing closed would break every existing
 *     deployment on upgrade.
 *   - **A key presented, and wrong** → refused on *any* request, reads included. A slicer's
 *     "test connection" then gets an honest answer, and an operator can verify the gate
 *     with a request that changes nothing.
 *   - **No key presented** → reads pass; writes are refused.
 *
 * This module is transport-neutral on purpose. `authorize()` takes the presented key as a
 * string and returns a verdict; `extractKey()` reads it from HTTP headers; `guardHttp()` is
 * the thin wrapper that writes the 401. The `/ws` (ELEG-140), `/mcp` (ELEG-141),
 * Moonraker (ELEG-142) and OctoPrint (ELEG-143) children reuse `authorize()` with their
 * own key source and their own refusal shape (OctoPrint answers 403, a WebSocket replies
 * with a frame).
 *
 * **The key is never logged and never echoed** — not in a refusal, not in a log line.
 */

import { createHash, timingSafeEqual } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';

/** What a request presented: `null` when it presented nothing at all. */
type PresentedKey = string | null;

export type AuthVerdict = 'ok' | 'missing' | 'invalid';

/**
 * The key a request presents, or `null` for none.
 *
 *   - `Authorization: Bearer <k>` first, then `X-Api-Key: <k>`.
 *   - Only the **Bearer** scheme counts. A `Basic` header forwarded by a reverse proxy
 *     that does its own auth is not a key, so it reads as absent rather than as a wrong
 *     key — otherwise every read behind such a proxy would be refused.
 *   - `Bearer` with an empty value is a key that was presented and is empty, so it is
 *     *invalid*, not absent. Over the wire it arrives as bare `Bearer` (the HTTP parser
 *     strips the trailing space), which is matched too.
 *   - The value is **not trimmed**. A key with stray whitespace is a different string.
 */
export function extractKey(req: Pick<IncomingMessage, 'headers'>): PresentedKey {
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const m = /^Bearer(?: (.*))?$/is.exec(auth);
    if (m) return m[1] ?? '';
  }
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string') return apiKey;
  if (Array.isArray(apiKey)) return apiKey[0] ?? '';
  return null;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Constant-time comparison of two keys. Both sides are hashed first, so neither the
 * length nor a matching prefix leaks through timing. An empty expected key never
 * matches: two empty strings hash equal, and "no key configured" is handled by the
 * caller, never by comparing against `''`.
 */
export function checkKey(presented: string, expected: string): boolean {
  if (!expected) return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

/**
 * The decision, with no transport in it. `expected` is the configured key (`''` when
 * unset); `presented` is what the request carried (`null` for nothing); `isWrite` is
 * the surface's own classification of the operation.
 */
export function authorize(
  expected: string,
  presented: PresentedKey,
  isWrite: boolean,
): AuthVerdict {
  if (!expected) return 'ok';
  if (presented !== null) return checkKey(presented, expected) ? 'ok' : 'invalid';
  return isWrite ? 'missing' : 'ok';
}

/** The refusal body. Says what is needed and where; never contains the key. */
export const UNAUTHORIZED_MESSAGE =
  'This action needs the service API key. Send it as "Authorization: Bearer <key>" or "X-Api-Key: <key>".';

/**
 * HTTP guard: returns true when the request may proceed, or answers 401 and returns
 * false. The caller must stop when this returns false.
 */
export function guardHttp(
  req: IncomingMessage,
  res: ServerResponse,
  expected: string,
  isWrite: boolean,
): boolean {
  const verdict = authorize(expected, extractKey(req), isWrite);
  if (verdict === 'ok') return true;
  res.writeHead(401, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': 'Bearer',
  });
  res.end(
    JSON.stringify({
      error: verdict === 'invalid' ? 'Invalid API key' : 'API key required',
      message: UNAUTHORIZED_MESSAGE,
    }),
  );
  return false;
}
