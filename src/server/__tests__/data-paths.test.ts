import { afterEach, describe, expect, it } from 'vitest';
import {
  captureLogDir,
  gcodeCacheDir,
  getDataDir,
  initDataPaths,
  resetDataPathsForTest,
} from '../data-paths.js';

/**
 * DATA_DIR is honoured by the gcode cache and the debug captures (ELEG-70).
 *
 * Both used to be built from the working directory — `join(process.cwd(), 'data', …)`
 * and the relative `join('data', 'logs', …)`. That coincides with `DATA_DIR` at its
 * default and only at its default, so the bug was invisible on metal and in the
 * container alike, and appeared only for someone who set `DATA_DIR` elsewhere — which
 * the README documents as supported.
 *
 * The assertions below are therefore written against a directory that is deliberately
 * NOT `$CWD/data`; against the old code every one of them fails.
 */

afterEach(() => {
  resetDataPathsForTest();
});

describe('gcodeCacheDir', () => {
  it('follows DATA_DIR rather than the working directory', () => {
    initDataPaths('/srv/elegoo-data');
    expect(gcodeCacheDir()).toBe('/srv/elegoo-data/gcode-cache');
  });

  it('does not smuggle the process cwd into the path', () => {
    // The precise regression: `join(process.cwd(), 'data', 'gcode-cache')` produced an
    // absolute path under the checkout no matter what DATA_DIR said.
    initDataPaths('/srv/elegoo-data');
    expect(gcodeCacheDir()).not.toContain(process.cwd());
  });

  it('handles a relative DATA_DIR without rewriting it', () => {
    initDataPaths('./custom-data');
    expect(gcodeCacheDir()).toBe('custom-data/gcode-cache');
  });
});

describe('captureLogDir', () => {
  it('follows DATA_DIR', () => {
    initDataPaths('/srv/elegoo-data');
    expect(captureLogDir()).toBe('/srv/elegoo-data/logs');
  });

  it('lands in the same place initLogger writes service.log', () => {
    // Both are diagnostics a user is told to go and fetch, so they must agree — the
    // capture endpoint writing somewhere else is how a capture becomes unretrievable.
    initDataPaths('/srv/elegoo-data');
    expect(captureLogDir()).toBe('/srv/elegoo-data/logs');
    expect(captureLogDir().startsWith(getDataDir())).toBe(true);
  });
});

describe('the default, which is what made this invisible', () => {
  it("matches config.dataDir's own default when never initialised", () => {
    // Not an accident: an uninitialised read must behave exactly as the old code did,
    // so importing a helper without calling initDataPaths cannot throw inside a request.
    expect(getDataDir()).toBe('./data');
    expect(gcodeCacheDir()).toBe('data/gcode-cache');
  });

  it('treats an empty DATA_DIR as unset rather than writing to the filesystem root', () => {
    initDataPaths('');
    expect(gcodeCacheDir()).toBe('data/gcode-cache');
  });
});
