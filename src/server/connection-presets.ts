/**
 * Connection presets — several saved printer addresses, one active at a time (ELEG-95).
 *
 * Still **one active printer and one MQTT connection**. Switching retargets the single
 * `MqttBridge` (it tears down the connection to A before it opens one to B) and resets
 * the single `StateStore`, so the AGENTS.md singleton rule is untouched. Several printers
 * *at once* is ELEG-96, and needs a keyed registry this module deliberately is not.
 *
 * Design decisions, recorded here because they are the part a reviewer will question:
 *
 * - **Where presets live.** `<DATA_DIR>/connection-presets.json`, via `data-paths.ts`.
 *   The environment's `PRINTER_IP` is never written to that file: it is always the
 *   built-in first entry (`id: "env"`), cannot be removed, and is what the service falls
 *   back to when the file is missing, malformed, or names a preset that no longer exists.
 *
 * - **Credentials are per printer, and `PRINTER_PASSWORD` never leaves its printer.** On
 *   the CC2 the password is the printer's own access code (it is the MQTT password *and*
 *   the `X-Token` on its HTTP API), so one value cannot be assumed to fit every machine.
 *   A saved preset carries its own password, or the published vendor default. It never
 *   inherits the environment's: the REST API that creates presets is unauthenticated, and
 *   inheriting would let anyone who can reach it add a preset pointing at an address they
 *   control and receive the real access code on the next switch.
 *
 * - **Passwords are write-only.** Stored in the presets file (the same trust level as
 *   `.env`, written 0600), never returned by any response — a preset reports
 *   `hasPassword` instead.
 *
 * - **The serial number is per printer.** The env printer keeps using
 *   `printer-sn.json` (so an existing install behaves exactly as before); a saved preset
 *   remembers its SN on its own entry. Registering printer B with A's cached SN would
 *   subscribe to the wrong topics.
 */

import { randomBytes } from 'crypto';
import { readFileSync, renameSync, writeFileSync } from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import { CONNECTION_PRESETS_API_ENV } from '../types.js';
import { isValidIPv4 } from './config.js';
import { getLogger } from './logger.js';
import { isValidSn } from './sn-cache.js';

const log = getLogger('Presets');

/** The id of the entry that comes from the environment. */
export const ENV_PRESET_ID = 'env';

/**
 * The CC2's published factory access code — protocol documentation, not a secret, and
 * the same value `config.ts` defaults `PRINTER_PASSWORD` to.
 */
export const VENDOR_DEFAULT_PASSWORD = '123456';

const MAX_NAME_LENGTH = 64;
const MAX_PASSWORD_LENGTH = 128;
const MAX_PRESETS = 32;
const MAX_BODY_BYTES = 4096;

/** A saved preset as it is stored on disk. */
interface StoredPreset {
  id: string;
  name: string;
  ip: string;
  password?: string;
  sn?: string;
}

interface PresetsFile {
  version: 1;
  active: string;
  presets: StoredPreset[];
}

/** Everything the service needs to connect to a printer. Server-side only. */
export interface ResolvedPreset {
  id: string;
  name: string;
  ip: string;
  password: string;
  sn: string;
  isDefault: boolean;
}

/** What may be shown to a client. Has no password field, by construction. */
export interface PublicPreset {
  id: string;
  name: string;
  ip: string;
  sn: string | null;
  hasPassword: boolean;
  isDefault: boolean;
  active: boolean;
}

export interface EnvPrinter {
  ip: string;
  password: string;
  /** From `PRINTER_SN` or `printer-sn.json`. */
  sn: string;
  cameraUrl: string;
  /** Remember an SN learned for the env printer (writes `printer-sn.json`). */
  onSnLearned?: (sn: string) => void;
}

export class PresetError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 500,
    message: string,
  ) {
    super(message);
  }
}

export class ConnectionPresets {
  private saved: StoredPreset[] = [];
  private activeId = ENV_PRESET_ID;

  constructor(
    private env: EnvPrinter,
    private filePath: string,
  ) {
    this.load();
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf-8');
    } catch {
      return; // No file yet: just the env printer, which is the normal first start.
    }
    try {
      const parsed = JSON.parse(raw) as Partial<PresetsFile> | null;
      const entries = Array.isArray(parsed?.presets) ? parsed.presets : [];
      const seen = new Set<string>([this.env.ip]);
      for (const e of entries) {
        const entry = e as Partial<StoredPreset> | null;
        if (
          !entry ||
          typeof entry.id !== 'string' ||
          entry.id === ENV_PRESET_ID ||
          typeof entry.name !== 'string' ||
          !isValidIPv4(entry.ip) ||
          seen.has(entry.ip)
        ) {
          log.warn(`Ignoring an invalid or duplicate entry in ${this.filePath}`);
          continue;
        }
        seen.add(entry.ip);
        this.saved.push({
          id: entry.id,
          name: entry.name.slice(0, MAX_NAME_LENGTH),
          ip: entry.ip,
          ...(typeof entry.password === 'string' ? { password: entry.password } : {}),
          ...(isValidSn(entry.sn) ? { sn: entry.sn } : {}),
        });
      }
      const active = parsed?.active;
      if (typeof active === 'string' && this.saved.some((p) => p.id === active)) {
        this.activeId = active;
      }
    } catch (err) {
      log.warn(
        `Could not read ${this.filePath}, using PRINTER_IP only: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.saved = [];
      this.activeId = ENV_PRESET_ID;
    }
  }

  private save(): void {
    const data: PresetsFile = { version: 1, active: this.activeId, presets: this.saved };
    const tmp = `${this.filePath}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
      renameSync(tmp, this.filePath);
    } catch (err) {
      throw new PresetError(
        500,
        `Could not save presets: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private resolve(id: string): ResolvedPreset | null {
    if (id === ENV_PRESET_ID) {
      return {
        id: ENV_PRESET_ID,
        name: 'Default (PRINTER_IP)',
        ip: this.env.ip,
        password: this.env.password,
        sn: this.env.sn,
        isDefault: true,
      };
    }
    const p = this.saved.find((s) => s.id === id);
    if (!p) return null;
    return {
      id: p.id,
      name: p.name,
      ip: p.ip,
      // Never the env password — see the header.
      password: p.password ?? VENDOR_DEFAULT_PASSWORD,
      sn: p.sn ?? '',
      isDefault: false,
    };
  }

  /** The preset the service is (or should be) connected to. */
  active(): ResolvedPreset {
    return this.resolve(this.activeId) ?? (this.resolve(ENV_PRESET_ID) as ResolvedPreset);
  }

  get(id: string): ResolvedPreset | null {
    return this.resolve(id);
  }

  /** The camera URL for a preset: `CAMERA_URL` belongs to the env printer only. */
  cameraUrlFor(preset: ResolvedPreset): string {
    return preset.isDefault ? this.env.cameraUrl : `http://${preset.ip}:8080`;
  }

  list(): PublicPreset[] {
    const toPublic = (r: ResolvedPreset, hasPassword: boolean): PublicPreset => ({
      id: r.id,
      name: r.name,
      ip: r.ip,
      sn: r.sn || null,
      hasPassword,
      isDefault: r.isDefault,
      active: r.id === this.active().id,
    });
    const env = this.resolve(ENV_PRESET_ID) as ResolvedPreset;
    return [
      toPublic(env, true),
      ...this.saved.map((p) => toPublic(this.resolve(p.id) as ResolvedPreset, !!p.password)),
    ];
  }

  add(input: { name?: unknown; ip?: unknown; password?: unknown }): PublicPreset {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > MAX_NAME_LENGTH) {
      throw new PresetError(400, `name is required (1-${MAX_NAME_LENGTH} characters)`);
    }
    if (!isValidIPv4(input.ip)) {
      throw new PresetError(400, 'ip must be a valid IPv4 address, the same rule as PRINTER_IP');
    }
    const ip = input.ip;
    let password: string | undefined;
    if (input.password !== undefined && input.password !== '') {
      if (typeof input.password !== 'string' || input.password.length > MAX_PASSWORD_LENGTH) {
        throw new PresetError(400, `password must be a string of at most ${MAX_PASSWORD_LENGTH}`);
      }
      password = input.password;
    }
    if (ip === this.env.ip || this.saved.some((p) => p.ip === ip)) {
      throw new PresetError(409, `a preset for ${ip} already exists`);
    }
    if (this.saved.length >= MAX_PRESETS) {
      throw new PresetError(409, `at most ${MAX_PRESETS} presets can be saved`);
    }
    const preset: StoredPreset = {
      id: randomBytes(6).toString('hex'),
      name,
      ip,
      ...(password ? { password } : {}),
    };
    this.saved.push(preset);
    try {
      this.save();
    } catch (err) {
      this.saved.pop();
      throw err;
    }
    return this.list().find((p) => p.id === preset.id) as PublicPreset;
  }

  remove(id: string): void {
    if (id === ENV_PRESET_ID) {
      throw new PresetError(409, 'the PRINTER_IP preset comes from the environment');
    }
    const idx = this.saved.findIndex((p) => p.id === id);
    if (idx === -1) throw new PresetError(404, 'no such preset');
    if (id === this.activeId) {
      throw new PresetError(409, 'switch to another printer before removing the active one');
    }
    const [removed] = this.saved.splice(idx, 1);
    try {
      this.save();
    } catch (err) {
      this.saved.splice(idx, 0, removed);
      throw err;
    }
  }

  /** Record which preset is active. Does not connect anything — see `switchActivePrinter`. */
  setActive(id: string): void {
    if (!this.resolve(id)) throw new PresetError(404, 'no such preset');
    const previous = this.activeId;
    this.activeId = id;
    try {
      this.save();
    } catch (err) {
      this.activeId = previous;
      throw err;
    }
  }

  /** Remember an SN learned for a preset, so its next connect registers immediately. */
  rememberSn(id: string, sn: string): void {
    if (!isValidSn(sn)) return;
    if (id === ENV_PRESET_ID) {
      this.env.sn = sn;
      this.env.onSnLearned?.(sn);
      return;
    }
    const p = this.saved.find((s) => s.id === id);
    if (!p || p.sn === sn) return;
    p.sn = sn;
    try {
      this.save();
    } catch (err) {
      // Costs one discovery cycle next time, never a connection.
      log.warn((err as Error).message);
    }
  }
}

// ── Switching ───────────────────────────────────────────────────────────────

export interface SwitchDeps {
  presets: ConnectionPresets;
  bridge: {
    readonly isConnected: boolean;
    retarget(target: {
      ip: string;
      password: string;
      sn: string;
      onSnLearned: (sn: string) => void;
    }): void;
  };
  store: {
    readonly status: { machine_status?: { status?: number } } | null;
    resetForPrinterSwitch(): void;
  };
  /** Point everything else that reads the printer's address at the new one. */
  afterSwitch?: (preset: ResolvedPreset) => void;
}

/** CC2 `machine_status.status` while a job is running. */
const MACHINE_STATUS_PRINTING = 2;

/**
 * Make `id` the one active printer.
 *
 * Refused while the current printer is connected and printing: switching would silently
 * stop Telegram progress, AI monitoring and the print report for a job that is still
 * running. A printer that is not connected cannot be monitored anyway, so it never blocks
 * switching away from it.
 */
export function switchActivePrinter(
  deps: SwitchDeps,
  id: string,
): { changed: boolean; active: PublicPreset } {
  const target = deps.presets.get(id);
  if (!target) throw new PresetError(404, 'no such preset');
  const current = deps.presets.active();
  const publicActive = () => deps.presets.list().find((p) => p.active) as PublicPreset;
  if (target.id === current.id) return { changed: false, active: publicActive() };

  if (
    deps.bridge.isConnected &&
    deps.store.status?.machine_status?.status === MACHINE_STATUS_PRINTING
  ) {
    throw new PresetError(
      409,
      `${current.name} is printing — switching now would stop monitoring that job. Wait for it to finish.`,
    );
  }

  // Persist first: if the file cannot be written, nothing has been torn down yet.
  deps.presets.setActive(target.id);

  log.info(`Switching printer: ${current.name} (${current.ip}) → ${target.name} (${target.ip})`);
  // One connection, ever: retarget closes A before it opens B.
  deps.bridge.retarget({
    ip: target.ip,
    password: target.password,
    sn: target.sn,
    onSnLearned: (sn) => deps.presets.rememberSn(target.id, sn),
  });
  // Printer B must never be shown A's state. Safe to do after retarget: A's listeners are
  // gone, and B cannot have delivered anything yet — its connect is asynchronous.
  deps.store.resetForPrinterSwitch();
  deps.afterSwitch?.(target);

  return { changed: true, active: publicActive() };
}

// ── REST ────────────────────────────────────────────────────────────────────

export interface PresetsRouteDeps extends SwitchDeps {
  /** `CONNECTION_PRESETS_API=true`. Reads are always allowed; writes need this. */
  writable: boolean;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      if (tooBig) return;
      body += chunk.toString();
      if (body.length > MAX_BODY_BYTES) tooBig = true;
    });
    req.on('end', () => {
      if (tooBig) return reject(new PresetError(400, 'request body too large'));
      if (!body) return resolve({});
      try {
        const parsed: unknown = JSON.parse(body);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new PresetError(400, 'body must be a JSON object'));
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new PresetError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * `/api/printers` — list, add, remove and activate presets.
 *
 *   GET    /api/printers               → { writable, presets }
 *   POST   /api/printers               { name, ip, password? } → 201 { preset }
 *   DELETE /api/printers/:id           → { ok }
 *   POST   /api/printers/:id/activate  → { changed, active }
 *
 * Deliberately **not** on `/mcp`, Moonraker, OctoPrint, Telegram or the WebSocket: the
 * service is unauthenticated, and re-pointing it moves every consumer at once and makes
 * it dial an address a request chose. Writes are off unless the operator opts in.
 *
 * Returns false when the URL is not one of these routes.
 */
export function handlePresetsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PresetsRouteDeps,
): boolean {
  const path = (req.url || '').split('?')[0];
  const match = /^\/api\/printers(?:\/([a-z0-9]+)(\/activate)?)?\/?$/.exec(path);
  if (!match) return false;
  const [, id, activate] = match;
  const method = req.method || 'GET';

  const run = async (): Promise<void> => {
    if (!id && method === 'GET') {
      return send(res, 200, { writable: deps.writable, presets: deps.presets.list() });
    }
    const allowed = (!id && method === 'POST') || (id && method === (activate ? 'POST' : 'DELETE'));
    if (!allowed) return send(res, 405, { error: 'Method not allowed' });
    if (!deps.writable) {
      throw new PresetError(
        403,
        `Changing printer presets over the API is disabled. Set ${CONNECTION_PRESETS_API_ENV}=true to enable it — the API has no authentication.`,
      );
    }
    if (!id) {
      const body = await readJson(req);
      return send(res, 201, { preset: deps.presets.add(body) });
    }
    if (activate) {
      return send(res, 200, switchActivePrinter(deps, id));
    }
    deps.presets.remove(id);
    return send(res, 200, { ok: true });
  };

  run().catch((err: unknown) => {
    if (res.headersSent) return;
    if (err instanceof PresetError) return send(res, err.status, { error: err.message });
    log.error('Preset request failed:', err);
    send(res, 500, { error: 'Internal server error' });
  });
  return true;
}
