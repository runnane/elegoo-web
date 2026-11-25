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
 * Returned in place of a fabricated JWT / refresh token / created user (ELEG-53).
 *
 * ELEG-26 withdrew the fake **API key** and deliberately left the session-credential
 * surface alone, because the breakage risk was different and unassessed. This is that
 * follow-up: `access.login`, `access.refresh_jwt` and `access.post_user` were handing
 * back `elegoo-compat-jwt-token` / `elegoo-compat-refresh-token` and, for `post_user`, a
 * "created" user that is stored nowhere. Nothing was ever issued, stored or checked.
 *
 * `post_user` was the worst of them: inventing a user implies a user store, and there is
 * no user store.
 *
 * These are safe to withdraw because `access.info` reports `login_required: false`, which
 * is how a well-behaved client learns not to log in — so a client reaching these was
 * already off the documented path. `oneshot_token` is the exception and is kept; see
 * `ONESHOT_TOKEN` below.
 */
export const NO_SESSIONS_MESSAGE =
  'This service has no authentication and issues no tokens or user accounts. ' +
  'See access.info: login_required is false. ' +
  'Access is controlled by the network it is reachable from.';

/**
 * The one credential-shaped answer that is deliberately **kept**.
 *
 * In real Moonraker `oneshot_token` exists so a browser can open a WebSocket or a camera
 * stream where an `Authorization` header cannot be set — the token goes in the query
 * string instead. A client may fetch one **before** it reads `access.info`, so refusing
 * it risks breaking the WebSocket connection outright. That is a regression, not a
 * security improvement, and this service checks nothing either way: withdrawing it would
 * remove no protection whatsoever, because there is none to remove.
 *
 * So it keeps answering — but with a string that tells the truth when it turns up in a
 * URL, a proxy log or a browser's network tab, instead of one that reads like a
 * credential. Any value works, since nothing validates it on the way back in.
 *
 * If a future change ever adds real authentication, this is one of the places that has
 * to stop being a no-op.
 */
export const ONESHOT_TOKEN = 'no-auth-required';

/**
 * OctoPrint's `api` block in `GET /api/settings`.
 *
 * `enabled` says whether this server checks an API key — which, since ELEG-143, it does
 * on the OctoPrint layer exactly when `SERVICE_API_KEY` is set. With it unset,
 * `enabled: false` is the honest statement OctoPrint clients already understand. Either
 * way **`key` is always null**: the old fixed key made clients show themselves as
 * authenticated (ELEG-26), and the real key must never be served to a caller — a read is
 * open, so serving it would hand it to anyone.
 */
export function octoprintApiSettings(keyConfigured: boolean): { enabled: boolean; key: null } {
  return { enabled: keyConfigured, key: null };
}

/**
 * How a caller's access to the OctoPrint layer came about (ELEG-143):
 *
 *   - `open` — `SERVICE_API_KEY` is unset, so every caller has full control. That is the
 *     exposure ELEG-2 is about, and understating it would be its own dishonesty.
 *   - `apikey` — the key is set and the caller presented it.
 *   - `guest` — the key is set and the caller presented none: it may read, nothing else.
 */
export type OctoPrintAccess = 'open' | 'apikey' | 'guest';

/**
 * OctoPrint's `GET /api/currentuser` body. A guest is reported as one — `name: null` and
 * the `guests` group — rather than as the admin it is not.
 */
export function octoprintCurrentUser(access: OctoPrintAccess): Record<string, unknown> {
  if (access === 'guest') {
    return { name: null, admin: false, groups: ['guests'], permissions: [], roles: [] };
  }
  return {
    name: 'elegoo',
    admin: true,
    groups: ['admins', 'users'],
    permissions: [],
    roles: ['admin', 'user'],
  };
}

/**
 * OctoPrint's `POST /api/login` body, for a caller that has full control (`open` or
 * `apikey`). A `guest` never gets here: with the key set, a login that presents no key is
 * refused 403 by the router's gate, which is what OctoPrint answers for a failed login.
 *
 * `_login_mechanism` says how access was granted: `'apikey'` when the key was presented,
 * null when nothing was checked. **No `apikey` field is ever returned** — the old fixed
 * string was ELEG-26's lie, and echoing the real key back is pointless at best.
 */
export function octoprintLoginPayload(
  access: Exclude<OctoPrintAccess, 'guest'>,
): Record<string, unknown> {
  return {
    _is_external_client: false,
    _login_mechanism: access === 'apikey' ? 'apikey' : null,
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
