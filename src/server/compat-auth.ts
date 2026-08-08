/**
 * What the compat layers say about authentication — which is that there isn't any.
 *
 * Both layers used to answer credential requests with a plausible fixed string:
 * OctoPrint returned `apikey: 'elegoo-cc2-compat'`, Moonraker answered
 * `access.get_api_key` with `'elegoo-compat-api-key'`. Nothing was ever checked against
 * either. A client that asked got an answer and displayed itself as **authenticated**,
 * and anyone auditing the code could find the handling and conclude an auth path
 * existed. ELEG-2's description had to carry a warning not to read these as evidence —
 * that warning was only necessary because the code lied (ELEG-26).
 *
 * This service has no authentication at all. See `.agents/security.md`.
 *
 * Kept in its own module, free of dependencies, so both layers say the same thing and
 * the shapes can be asserted directly — the compat layers are pure state→JSON
 * translation, which `.agents/testing.md` names as the high-value test target, and a
 * client breaks silently when a field's shape drifts.
 */

/** Returned in place of a fabricated key. Phrased for a human reading a client's error. */
export const NO_API_KEY_MESSAGE =
  'This service has no authentication and issues no API key. ' +
  'Access is controlled by the network it is reachable from.';

/** Moonraker's JSON-RPC error code for an unavailable method. */
export const MOONRAKER_NO_API_KEY_CODE = -32601;

/**
 * OctoPrint's `api` block in `GET /api/settings`.
 *
 * `enabled: false` is the honest statement, and it is a statement OctoPrint clients
 * already understand: it means this server does not do API-key authentication. The old
 * `enabled: true` plus a fixed key claimed the opposite.
 */
export function octoprintApiSettings(): { enabled: false; key: null } {
  return { enabled: false, key: null };
}

/**
 * OctoPrint's `POST /api/login` body.
 *
 * `admin`/`user` stay true, and that is not a lie: with no authentication every caller
 * genuinely does have full control of this service — that is precisely the exposure
 * ELEG-2 is about, and understating it would be its own kind of dishonesty. What goes
 * is the claim about *how* the caller got that access: there is no api key and no login
 * mechanism, so `apikey` is dropped and `_login_mechanism` is null.
 */
export function octoprintLoginPayload(): Record<string, unknown> {
  return {
    _is_external_client: false,
    _login_mechanism: null,
    active: true,
    admin: true,
    groups: ['admins', 'users'],
    name: 'elegoo',
    needs: { group: ['admins'], role: [] },
    permissions: [],
    roles: ['admin', 'user'],
    user: true,
  };
}
