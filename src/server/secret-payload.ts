/**
 * Redaction of the MQTT methods that carry the printer's auth token (ELEG-186).
 *
 * Every raw MQTT request and response the service sees is forwarded to **every** `/ws`
 * client (reads and broadcasts are open by design, see `ws-transport.ts`), kept in the raw
 * log ring buffer, and written to `/api/debug/capture` files. Three methods in the
 * firmware's own enum (`method.h`, ELEG-100) are about the token itself:
 *
 *   - 1049 `UPDATE_TOKEN`     — the request's params carry a new token;
 *   - 1050 `GET_TOKEN`        — the reply, by its name, carries the current token;
 *   - 1053 `SET_TOKEN_SWITCH` — turns token authentication on or off.
 *
 * Nothing in this repo sends any of them, but another client on the broker (or a `/ws`
 * command frame, or MCP `send_command`) can, and whatever comes back would be fanned out.
 * So `StateStore` passes every forwarded payload through `redactSecretPayload` first.
 *
 * The redaction is default-deny inside the payload: `id` and `method` survive at the top
 * level and `error_code` at any depth, so the log viewer can still label the line and say
 * whether it succeeded. Every other leaf becomes `REDACTED`, whatever its key is called,
 * because the reply shape of 1050 is documented nowhere locally.
 */

/** Methods whose payloads are redacted before anything leaves the service. */
export const SECRET_METHODS: ReadonlySet<number> = new Set([1049, 1050, 1053]);

export const REDACTED = '[redacted]';

const KEPT_TOP_LEVEL = new Set(['id', 'method']);
const KEPT_ANY_DEPTH = new Set(['error_code']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function redactValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redactValue);
  if (isRecord(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, inner] of Object.entries(v)) {
      out[k] = KEPT_ANY_DEPTH.has(k) ? inner : redactValue(inner);
    }
    return out;
  }
  return REDACTED;
}

/** The `method` a raw MQTT message names, if it names one. */
export function methodOf(payload: unknown): number | undefined {
  if (!isRecord(payload)) return undefined;
  const m = Number(payload.method);
  return Number.isFinite(m) ? m : undefined;
}

/**
 * A copy of `payload` with its token-bearing fields replaced, when `method` is one of
 * `SECRET_METHODS`; otherwise `payload` itself, untouched (same reference).
 */
export function redactSecretPayload<T>(method: unknown, payload: T): T {
  // Coerced, because the bridge casts `data.method` without checking it: a string "1050"
  // must not slip past a number lookup on one path while `methodOf` catches it on another.
  if (method == null || !SECRET_METHODS.has(Number(method)) || !isRecord(payload)) return payload;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    out[k] = KEPT_TOP_LEVEL.has(k) || KEPT_ANY_DEPTH.has(k) ? v : redactValue(v);
  }
  return out as T;
}
