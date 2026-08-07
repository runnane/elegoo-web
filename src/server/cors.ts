/**
 * Cross-origin policy for every HTTP surface (ELEG-24).
 *
 * All five of them used to answer `Access-Control-Allow-Origin: *`. With **no credential
 * to withhold**, that is not a minor misconfiguration: any web page a browser on this
 * network loads could issue cross-origin requests and read the responses. The attacker
 * never had to reach the network — only get someone already on it to open a page.
 * `SameSite` is irrelevant, because there is no cookie to protect.
 *
 * Reachable that way: `set_temperature`, `move`, `home`, `start_print`, `stop_print` and
 * `emergency_stop` — physical consequences on a machine with heaters and motors — plus
 * `/api/snapshot` and `/api/stream`, a live camera image of the room.
 *
 * The default is now **same-origin**: no header at all unless an origin is configured.
 * The SPA is served by the origin it calls, so it needs none of this.
 */

/** Parsed `CORS_ALLOWED_ORIGINS`. `'*'` is the explicit, opt-in escape hatch. */
export type CorsPolicy = { kind: 'none' } | { kind: 'any' } | { kind: 'list'; origins: string[] };

/**
 * Parse the configured origin list.
 *
 * Unset or empty means `none` — same-origin only. A bare `*` restores the old
 * everyone-welcome behaviour, but now somebody has to type it, which is the point:
 * the dangerous setting should be a deliberate act, not a default nobody chose.
 *
 * Origins are compared exactly, after stripping a trailing slash. No wildcard subdomains
 * and no prefix matching — `https://evil.example` must not be admitted by a rule meant
 * for `https://evil.example.good.test`, and prefix logic is how that happens.
 */
export function parseCorsPolicy(raw: string | undefined): CorsPolicy {
  const value = raw?.trim();
  if (!value) return { kind: 'none' };
  if (value === '*') return { kind: 'any' };

  const origins = [
    ...new Set(
      value
        .split(',')
        .map((s) => s.trim().replace(/\/+$/, ''))
        .filter(Boolean),
    ),
  ];
  return origins.length > 0 ? { kind: 'list', origins } : { kind: 'none' };
}

/**
 * The value for `Access-Control-Allow-Origin`, or `null` to send no header at all.
 *
 * Returning the *request's* origin rather than the configured list is deliberate — a
 * browser rejects a header naming several origins — and it is why the match has to be
 * exact. A request with no `Origin` is not a cross-origin request and needs no header.
 */
export function allowOriginFor(
  policy: CorsPolicy,
  requestOrigin: string | undefined,
): string | null {
  if (policy.kind === 'none') return null;
  if (policy.kind === 'any') return '*';
  if (!requestOrigin) return null;
  return policy.origins.includes(requestOrigin.replace(/\/+$/, '')) ? requestOrigin : null;
}

/** Minimal shape of what `applyCors` writes to — keeps this module free of node:http. */
interface HeaderSink {
  setHeader(name: string, value: string): void;
}

/** Set the computed headers, if any. An empty map means: send nothing. */
export function applyCors(res: HeaderSink, headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
}

/** Header name → value pairs to set, given the policy and the request's Origin. */
export function corsHeaders(
  policy: CorsPolicy,
  requestOrigin: string | undefined,
  methods: string,
  headers: string,
  exposeHeaders?: string,
): Record<string, string> {
  const allow = allowOriginFor(policy, requestOrigin);
  if (allow === null) return {};

  const out: Record<string, string> = {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': headers,
    'Access-Control-Max-Age': '86400',
  };
  if (exposeHeaders) out['Access-Control-Expose-Headers'] = exposeHeaders;
  // Responses differ by Origin, so a shared cache must not serve one origin's response
  // to another. Omitted when the policy is 'any', where the answer is the same for all.
  if (policy.kind === 'list') out.Vary = 'Origin';
  return out;
}
