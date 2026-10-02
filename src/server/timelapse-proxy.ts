/**
 * Timelapse video proxy — the pure half (ELEG-114).
 *
 * The printer reports a timelapse as `time_lapse_video_url`. The browser used to play that
 * directly, which only works from the printer's own network. `GET /api/timelapse/video?url=…`
 * now streams it through the service, and this module decides what that route may fetch.
 *
 * The service is unauthenticated, so the route is an SSRF surface: the upstream host is
 * ALWAYS the configured printer and never anything taken from the request. A value naming a
 * different host is refused rather than rewritten, so a mistake is loud.
 */

export interface TimelapseUpstream {
  ok: true;
  /** Upstream TCP port: the URL's own when it carries one, else the printer's HTTP port. */
  port: number;
  /** Absolute path (plus query, if any) to request from the printer. */
  path: string;
}

export interface TimelapseRejection {
  ok: false;
  error: string;
}

/** The printer's HTTP server — the same port the file download and upload proxies use. */
export const PRINTER_HTTP_PORT = 80;

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const PLACEHOLDER_HOST = 'placeholder.invalid';

/** C0 controls and DEL. A char-code loop, because biome forbids control chars in a regex. */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

function reject(error: string): TimelapseRejection {
  return { ok: false, error };
}

/**
 * Turn the request's `url` value into a printer path, or refuse it.
 * Accepts the printer's absolute http URL (only if its host is `printerIp`) or a bare
 * path / name. Rejects empty values, other hosts, other schemes, `..`, backslashes and
 * control characters (raw or percent-encoded).
 */
export function resolveTimelapseUpstream(
  raw: string | null | undefined,
  printerIp: string,
): TimelapseUpstream | TimelapseRejection {
  const value = (raw ?? '').trim();
  if (!value) return reject('Missing url parameter');
  if (value.length > 2048) return reject('url too long');
  if (hasControlChar(value)) return reject('Invalid characters in url');
  if (value.includes('\\')) return reject('Invalid characters in url');
  if (value.startsWith('//')) return reject('Protocol-relative URLs are not allowed');

  let port = PRINTER_HTTP_PORT;
  let parsed: URL;
  if (SCHEME.test(value)) {
    try {
      parsed = new URL(value);
    } catch {
      return reject('Malformed url');
    }
    if (parsed.protocol !== 'http:') return reject('Only http URLs are allowed');
    if (parsed.username || parsed.password) return reject('Credentials in url are not allowed');
    if (parsed.hostname !== printerIp) return reject('url does not point at the printer');
    if (parsed.port) port = Number(parsed.port);
  } else {
    try {
      parsed = new URL(value, `http://${PLACEHOLDER_HOST}/`);
    } catch {
      return reject('Malformed url');
    }
    if (parsed.hostname !== PLACEHOLDER_HOST) return reject('url does not point at the printer');
  }

  // Judge the decoded path: `%2e%2e`, `%5c` and `%00` must not slip past the raw checks.
  let decoded: string;
  try {
    decoded = decodeURIComponent(parsed.pathname);
  } catch {
    return reject('Malformed url');
  }
  if (hasControlChar(decoded) || decoded.includes('\\')) return reject('Invalid characters in url');
  if (decoded.split('/').some((seg) => seg === '..' || seg === '.')) {
    return reject('Path traversal is not allowed');
  }
  // The URL parser collapses `a/../b` and `%2e%2e` BEFORE we see pathname, so the checks
  // above only see the already-resolved path. Judge the decoded input as well.
  let decodedRaw: string;
  try {
    decodedRaw = decodeURIComponent(value);
  } catch {
    return reject('Malformed url');
  }
  if (hasControlChar(decodedRaw) || decodedRaw.includes('\\')) {
    return reject('Invalid characters in url');
  }
  if (decodedRaw.split(/[/?#]/).some((seg) => seg === '..')) {
    return reject('Path traversal is not allowed');
  }
  if (decoded === '/' || decoded === '') return reject('url has no path');

  return { ok: true, port, path: `${parsed.pathname}${parsed.search}` };
}
