/**
 * What the compat layers say about authentication.
 *
 * Both layers used to answer credential requests with a plausible fixed string:
 * OctoPrint returned `apikey: 'elegoo-cc2-compat'`, Moonraker answered
 * `access.get_api_key` with `'elegoo-compat-api-key'`. Nothing was ever checked against
 * either. A client that asked got an answer and displayed itself as **authenticated**,
 * and anyone auditing the code could find the handling and conclude an auth path
 * existed. ELEG-2's description had to carry a warning not to read these as evidence —
 * that warning was only necessary because the code lied (ELEG-26).
 *
 * Both layers now check something: the one shared service key, `SERVICE_API_KEY`, gates
 * their writes — OctoPrint inside `createOctoPrintRouter` (ELEG-143), Moonraker through
 * `moonraker-auth.ts` (ELEG-142). It is set by the operator and typed into the client —
 * **this service never hands it out**, so every answer below still withholds it, and reads
 * still need no credential at all. See `.agents/security.md`.
 *
 * Kept in its own module, free of dependencies, so both layers say the same thing and
 * the shapes can be asserted directly — the compat layers are pure state→JSON
 * translation, which `.agents/testing.md` names as the high-value test target, and a
 * client breaks silently when a field's shape drifts.
 */

/**
 * Returned by `access.get_api_key` in place of a key. Phrased for a human reading a
 * client's error, and true whether or not a key is configured.
 */
export const NO_API_KEY_MESSAGE =
  'This service does not hand out its API key. Reads need no credential. ' +
  'Writes need the SERVICE_API_KEY the operator configured, when one is set: ' +
  'send it as X-Api-Key, or as api_key in server.connection.identify.';

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
 * no user store. There still is none: the service key (ELEG-142) is a shared key, not a
 * user login, so Moonraker's login/JWT path stays unimplemented (ELEG-145 is the owner's
 * call on whether Fluidd gets one).
 *
 * These are safe to withdraw because `access.info` reports `login_required: false`, which
 * is how a well-behaved client learns not to log in — so a client reaching these was
 * already off the documented path. `oneshot_token` is the exception and is kept; see
 * `ONESHOT_TOKEN` below.
 */
export const NO_SESSIONS_MESSAGE =
  'This service issues no tokens or user accounts. ' +
  'See access.info: login_required is false, so reads need no login. ' +
  'Writes need the service API key when one is configured (X-Api-Key, or api_key in ' +
  'server.connection.identify).';

/**
 * The one credential-shaped answer that is deliberately **kept**.
 *
 * In real Moonraker `oneshot_token` exists so a browser can open a WebSocket or a camera
 * stream where an `Authorization` header cannot be set — the token goes in the query
 * string instead. A client may fetch one **before** it reads `access.info`, so refusing
 * it risks breaking the WebSocket connection outright.
 *
 * **It still grants nothing, now that a key exists (ELEG-142).** Nothing reads a
 * `?token=` back: a WebSocket opened with it is an anonymous connection — it reads, and
 * its writes get Moonraker's 401 until it presents the service key through
 * `server.connection.identify {api_key}`. The camera is open by design. So answering
 * costs nothing, and the string tells the truth when it turns up in a URL, a proxy log or
 * a browser's network tab.
 *
 * If a change ever makes this token *honoured* — accepted in place of the key — it has
 * to stop being a fixed string first, because this endpoint is open to anyone.
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
 * OctoPrint's `GET /api/currentuser` body. A guest is reported as one rather than as the
 * admin it is not. OctoPrint's data model says only that `name` is "unset if guest"; the
 * `null` name and the `guests` group are this service's choice, not measured OctoPrint
 * output.
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
 * OctoPrint's `POST /api/login` body — a passive-login answer describing the caller.
 * Login is open (OctoPrint's docs exempt it from the missing-key 403), so a `guest` gets
 * the guest record plus the login fields, inactive, rather than a refusal.
 *
 * `_login_mechanism` says how access was granted: `'apikey'` when the key was presented,
 * null otherwise. OctoPrint's API docs do not document this field's values; these are this
 * service's choice. **No `apikey` field is ever returned** — the old fixed string was
 * ELEG-26's lie, and echoing the real key back is pointless at best.
 */
export function octoprintLoginPayload(access: OctoPrintAccess): Record<string, unknown> {
  if (access === 'guest') {
    return {
      ...octoprintCurrentUser('guest'),
      _is_external_client: false,
      _login_mechanism: null,
      active: false,
      needs: { group: [], role: [] },
      user: false,
    };
  }
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
