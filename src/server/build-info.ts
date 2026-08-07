/**
 * Deploy stamp — which commit is actually running.
 *
 * Production is `/opt/elegooweb`, which is not a git checkout and carries no git
 * metadata, so `contrib/install.sh` writes `build-info.json` at the install root and
 * this reads it back. "Is this change live?" is then a `/api/health` request rather
 * than a hand-diff of two directories.
 *
 * An absent stamp is normal, not an error: `pnpm dev` runs from the checkout and any
 * deploy made before this landed has no file. Every failure — missing, unreadable,
 * malformed, wrong shape — degrades to `UNKNOWN_BUILD_INFO`, so the caller never has
 * to guard and `/api/health` never 500s over a version string.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getLogger } from './logger.js';

const log = getLogger('Build');

export interface BuildInfo {
  /** Full commit sha the install was made from. */
  commit: string | null;
  /** Abbreviated sha, for humans. */
  shortCommit: string | null;
  /** `git describe --tags --always --dirty` at install time. */
  describe: string | null;
  /** `version` from the deployed `package.json`. */
  version: string | null;
  /** ISO-8601 UTC timestamp of the install. */
  installedAt: string | null;
}

/**
 * Every key present and explicitly null. Serialising this rather than omitting the
 * field is what keeps an unstamped deploy distinguishable from a broken read at the
 * consumer: `.build.commit` always exists.
 */
export const UNKNOWN_BUILD_INFO: BuildInfo = {
  commit: null,
  shortCommit: null,
  describe: null,
  version: null,
  installedAt: null,
};

/**
 * Install root. This file is `<root>/src/server/build-info.ts` in the checkout and in
 * production alike, so resolving from the module beats `process.cwd()` — the systemd
 * unit happens to set `WorkingDirectory=/opt/elegooweb`, but that is a property of the
 * unit file, and a `cd` anywhere would break a cwd-relative path silently.
 */
export const BUILD_INFO_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'build-info.json',
);

/** Non-empty strings only — `""` and `null` from the stamp both mean "unknown". */
function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Read the deploy stamp. Never throws; unknown fields come back as null.
 *
 * @param path Stamp file to read. Defaults to the install root; the parameter exists
 *   so this is testable without touching the real one.
 */
export function readBuildInfo(path: string = BUILD_INFO_PATH): BuildInfo {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // Absent is the expected case in development — not worth a warning.
    return { ...UNKNOWN_BUILD_INFO };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('expected a JSON object');
    }
    const fields = parsed as Record<string, unknown>;
    return {
      commit: str(fields.commit),
      shortCommit: str(fields.shortCommit),
      describe: str(fields.describe),
      version: str(fields.version),
      installedAt: str(fields.installedAt),
    };
  } catch (err) {
    // A file that exists but cannot be read is worth saying out loud: it means the
    // installer wrote something wrong, and the deploy check will read as "unknown".
    log.warn(`Ignoring malformed ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return { ...UNKNOWN_BUILD_INFO };
  }
}

let cached: BuildInfo | null = null;

/**
 * The stamp, read once per process. `/api/health` is polled, so this must not hit the
 * filesystem per request; the file cannot change without a reinstall, and a reinstall
 * restarts the service.
 */
export function getBuildInfo(): BuildInfo {
  if (cached === null) cached = readBuildInfo();
  return cached;
}
