/**
 * Where the service writes, derived from one place (ELEG-70).
 *
 * Most of the service already builds its paths from `config.dataDir` — reports,
 * `state.json`, `moonraker-db.json`, `printer-sn.json`, `ai-labels.json`, and the logs
 * via `initLogger(config.dataDir)`. Two did not: the gcode cache was
 * `join(process.cwd(), 'data', 'gcode-cache')` and the debug-capture endpoint used the
 * relative `join('data', 'logs', …)`.
 *
 * **That was invisible because the default makes them coincide.** `DATA_DIR` defaults to
 * `./data`, so `$CWD/data` is the same directory — on metal (`WorkingDirectory=
 * /opt/elegooweb`) and in the container (`WORKDIR /app`) alike. It only diverges when
 * `DATA_DIR` points elsewhere, which `README.md` and `docker-compose.example.yml` both
 * document as supported. Then those two write somewhere nobody mounted or backs up: in a
 * container, into an unmounted layer that is discarded on every recreate.
 *
 * This module exists rather than threading `config` through the call sites because the
 * consumers are functions like `ensureCacheDir()`, `getCachedGcode(fileName)` and the
 * exported `cacheGcodeBuffer(fileName, data)` — adding a parameter to each would change
 * an exported signature to move a value that never varies within a process. `logger.ts`
 * already solves the identical problem the identical way, and `initDataPaths` is called
 * on the line below `initLogger` so the two stay together.
 */

import { join } from 'path';

/**
 * Deliberately seeded with the same default as `config.dataDir`, so a caller that never
 * initialises (a test importing one of these helpers directly) behaves exactly as the
 * code did before rather than throwing from inside a request handler. `index.ts` sets it
 * for the real process.
 */
const DEFAULT_DATA_DIR = './data';

let dataDir: string = DEFAULT_DATA_DIR;

/** Call once at startup, beside `initLogger`. */
export function initDataPaths(dir: string): void {
  dataDir = dir || DEFAULT_DATA_DIR;
}

/** The configured data directory. Exported mainly so a test can assert the wiring. */
export function getDataDir(): string {
  return dataDir;
}

/** Downloaded/uploaded gcode, kept for the preview and the layer estimates. */
export function gcodeCacheDir(): string {
  return join(dataDir, 'gcode-cache');
}

/**
 * Where `POST /api/debug/capture` writes, and where the capture list and reader look.
 * The same directory `initLogger` writes `service.log` into — deliberately, since both
 * are diagnostics a user is told to go and fetch.
 */
export function captureLogDir(): string {
  return join(dataDir, 'logs');
}

/** Reset to the default. For tests only. */
export function resetDataPathsForTest(): void {
  dataDir = DEFAULT_DATA_DIR;
}
