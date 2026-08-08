/**
 * Remember the printer's serial number across restarts (ELEG-60).
 *
 * `MqttBridge` can only learn the SN by overhearing an inbound `elegoo/<sn>/...`
 * message — but the printer only publishes while a client is registered. So after a
 * clean shutdown the printer goes quiet, a freshly started service has nothing to
 * overhear, and registration is never even attempted. The service sits in
 * `broker_only` until something else provokes the printer into talking.
 *
 * That is not theoretical. On 2026-08-08 two consecutive restarts of the same unit
 * against the same healthy printer took **27 minutes** and **never**.
 *
 * So the SN is written down the first time it is learned, and read back at startup.
 *
 * Deliberately a tiny file of its own rather than a field in `state.json`: that one is
 * loaded asynchronously and holds chart history, while this has to be available
 * synchronously before the first broker connect, and losing it must never cost more
 * than one discovery cycle.
 *
 * Every failure — missing, unreadable, malformed, empty — degrades to "unknown", which
 * is exactly the pre-ELEG-60 behaviour. It can slow a start down; it cannot break one.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getLogger } from './logger.js';

const log = getLogger('MQTT');

const FILE = 'printer-sn.json';

/**
 * A CC2 serial looks like `F01U3UD3798YT8K`. Validated rather than trusted because it
 * is interpolated straight into MQTT topic filters — a stray `#` or `/` from a corrupt
 * file would silently subscribe to the wrong thing.
 */
const SN_RE = /^[A-Za-z0-9_-]{4,64}$/;

export function isValidSn(value: unknown): value is string {
  return typeof value === 'string' && SN_RE.test(value);
}

export function snCachePath(dataDir: string): string {
  return join(dataDir, FILE);
}

/** The remembered SN, or `''` if there is not a usable one. Never throws. */
export function readCachedSn(dataDir: string): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(snCachePath(dataDir), 'utf-8'));
    const sn = (parsed as { sn?: unknown } | null)?.sn;
    return isValidSn(sn) ? sn : '';
  } catch {
    // Absent on a first-ever start, which is normal and not worth a warning.
    return '';
  }
}

/** Remember an SN. Never throws — a read-only data dir must not break registration. */
export function writeCachedSn(dataDir: string, sn: string): void {
  if (!isValidSn(sn)) return;
  try {
    writeFileSync(snCachePath(dataDir), JSON.stringify({ sn }), 'utf-8');
  } catch (err) {
    log.warn(`Could not cache printer SN: ${err instanceof Error ? err.message : String(err)}`);
  }
}
