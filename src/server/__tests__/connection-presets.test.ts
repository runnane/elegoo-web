/**
 * Connection presets: storage, validation, secrets and the REST surface (ELEG-95).
 *
 * Every address here is TEST-NET (RFC 5737). Nothing connects to anything: the bridge and
 * the store are stubs, and the REST handler is driven with an in-memory request.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONNECTION_PRESETS_API_ENV } from '../../types.js';
import { loadConfig } from '../config.js';
import {
  ConnectionPresets,
  ENV_PRESET_ID,
  handlePresetsRequest,
  PresetError,
  type PresetsRouteDeps,
  VENDOR_DEFAULT_PASSWORD,
} from '../connection-presets.js';
import { connectionPresetsPath, initDataPaths, resetDataPathsForTest } from '../data-paths.js';

const ENV_IP = '192.0.2.10';
// Generated, so a substring match on it can only mean the value leaked.
const ENV_PASSWORD = `env-secret-${Math.random().toString(36).slice(2)}`;
const PRESET_PASSWORD = `preset-secret-${Math.random().toString(36).slice(2)}`;

const ORIGINAL_ENV = process.env;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'connection-presets-'));
});
afterEach(() => {
  process.env = ORIGINAL_ENV;
  resetDataPathsForTest();
  rmSync(dir, { recursive: true, force: true });
});

function makePresets(file = join(dir, 'connection-presets.json')): ConnectionPresets {
  return new ConnectionPresets(
    { ip: ENV_IP, password: ENV_PASSWORD, sn: '', cameraUrl: `http://${ENV_IP}:8080` },
    file,
  );
}

describe('where presets live', () => {
  it('stores them under DATA_DIR, not the working directory, and reloads them', () => {
    initDataPaths(dir);
    const file = connectionPresetsPath();
    expect(file).toBe(join(dir, 'connection-presets.json'));
    expect(file).not.toContain(process.cwd());

    const added = makePresets(file).add({ name: 'Workshop', ip: '198.51.100.20' });
    expect(existsSync(file)).toBe(true);

    const reloaded = makePresets(file).list();
    expect(reloaded.map((p) => p.ip)).toEqual([ENV_IP, '198.51.100.20']);
    expect(reloaded[1].id).toBe(added.id);
  });

  it("makes the environment's PRINTER_IP the first, default and active entry", () => {
    const presets = makePresets();
    expect(presets.active()).toMatchObject({ id: ENV_PRESET_ID, ip: ENV_IP, isDefault: true });
    expect(presets.list()).toEqual([expect.objectContaining({ ip: ENV_IP, active: true })]);
  });

  it('falls back to PRINTER_IP alone when the file is malformed, rather than failing to start', () => {
    const file = join(dir, 'connection-presets.json');
    writeFileSync(file, '{ not json', 'utf-8');
    expect(makePresets(file).active().ip).toBe(ENV_IP);
  });

  it('drops a stored entry with a bad address instead of dialling it', () => {
    const file = join(dir, 'connection-presets.json');
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        active: 'bad',
        presets: [{ id: 'bad', name: 'Bad', ip: '999.1.1.1' }],
      }),
      'utf-8',
    );
    const presets = makePresets(file);
    expect(presets.list()).toHaveLength(1);
    expect(presets.active().ip).toBe(ENV_IP);
  });
});

describe('address validation', () => {
  const BAD = ['not-an-ip', '256.1.1.1', '1.2.3', '1.2.3.4.5', '192.0.2.1 ', 'printer.local'];

  it('refuses exactly what PRINTER_IP refuses', () => {
    const presets = makePresets();
    for (const bad of BAD) {
      process.env = { PRINTER_IP: bad } as NodeJS.ProcessEnv;
      expect(() => loadConfig(), `PRINTER_IP=${bad}`).toThrow(/PRINTER_IP/);
      expect(() => presets.add({ name: 'x', ip: bad }), `preset ${bad}`).toThrow(PresetError);
    }
  });

  it('accepts what PRINTER_IP accepts', () => {
    process.env = { PRINTER_IP: '203.0.113.7' } as NodeJS.ProcessEnv;
    expect(() => loadConfig()).not.toThrow();
    expect(makePresets().add({ name: 'x', ip: '203.0.113.7' }).ip).toBe('203.0.113.7');
  });

  it('refuses a second preset for an address that already has one', () => {
    const presets = makePresets();
    expect(() => presets.add({ name: 'dup', ip: ENV_IP })).toThrow(PresetError);
  });
});

describe('credentials', () => {
  it('never lists a password — only whether one is set', () => {
    const presets = makePresets();
    presets.add({ name: 'With code', ip: '198.51.100.20', password: PRESET_PASSWORD });
    const json = JSON.stringify(presets.list());
    expect(json).not.toContain(PRESET_PASSWORD);
    expect(json).not.toContain(ENV_PASSWORD);
    expect(presets.list()[1].hasPassword).toBe(true);
  });

  it('gives a preset without its own code the vendor default, never PRINTER_PASSWORD', () => {
    // The API that adds presets is unauthenticated. Inheriting would hand the real access
    // code to whatever address a request chose, on the next switch.
    const presets = makePresets();
    const { id } = presets.add({ name: 'No code', ip: '198.51.100.20' });
    expect(presets.get(id)?.password).toBe(VENDOR_DEFAULT_PASSWORD);
    expect(presets.get(ENV_PRESET_ID)?.password).toBe(ENV_PASSWORD);
  });
});

describe('removal', () => {
  it('refuses to remove the PRINTER_IP entry or the active preset', () => {
    const presets = makePresets();
    const { id } = presets.add({ name: 'B', ip: '198.51.100.20' });
    expect(() => presets.remove(ENV_PRESET_ID)).toThrow(PresetError);
    presets.setActive(id);
    expect(() => presets.remove(id)).toThrow(PresetError);
    presets.setActive(ENV_PRESET_ID);
    presets.remove(id);
    expect(presets.list()).toHaveLength(1);
  });
});

describe('CONNECTION_PRESETS_API', () => {
  it('is off unless explicitly turned on', () => {
    process.env = { PRINTER_IP: ENV_IP } as NodeJS.ProcessEnv;
    expect(loadConfig().connectionPresetsApi).toBe(false);
    process.env = { PRINTER_IP: ENV_IP, [CONNECTION_PRESETS_API_ENV]: 'true' } as NodeJS.ProcessEnv;
    expect(loadConfig().connectionPresetsApi).toBe(true);
  });
});

// ── REST ────────────────────────────────────────────────────────────────────

interface Reply {
  status: number;
  raw: string;
  body: Record<string, unknown>;
}

function call(deps: PresetsRouteDeps, method: string, url: string, body?: unknown): Promise<Reply> {
  return new Promise((resolve) => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const req = Object.assign(Readable.from(chunks), { method, url, headers: {} });
    let status = 0;
    const res = {
      headersSent: false,
      writeHead(code: number) {
        status = code;
        this.headersSent = true;
        return this;
      },
      end(raw: string) {
        resolve({ status, raw, body: JSON.parse(raw) as Record<string, unknown> });
      },
    };
    const handled = handlePresetsRequest(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      deps,
    );
    if (!handled) resolve({ status: -1, raw: '', body: {} });
  });
}

function makeDeps(writable: boolean) {
  const retarget = vi.fn();
  const resetForPrinterSwitch = vi.fn();
  const deps: PresetsRouteDeps = {
    presets: makePresets(),
    bridge: { isConnected: false, retarget },
    store: { status: null, resetForPrinterSwitch },
    writable,
  };
  return { deps, retarget, resetForPrinterSwitch };
}

describe('/api/printers', () => {
  it('lists presets with no password in the response', async () => {
    const { deps } = makeDeps(false);
    deps.presets.add({ name: 'B', ip: '198.51.100.20', password: PRESET_PASSWORD });
    const reply = await call(deps, 'GET', '/api/printers');
    expect(reply.status).toBe(200);
    expect(reply.body.writable).toBe(false);
    expect(reply.raw).not.toContain(PRESET_PASSWORD);
    expect(reply.raw).not.toContain(ENV_PASSWORD);
  });

  it('refuses every write unless the API is turned on, and names the variable', async () => {
    const { deps, retarget } = makeDeps(false);
    const { id } = deps.presets.add({ name: 'B', ip: '198.51.100.20' });

    const add = await call(deps, 'POST', '/api/printers', { name: 'C', ip: '203.0.113.30' });
    const activate = await call(deps, 'POST', `/api/printers/${id}/activate`);
    const remove = await call(deps, 'DELETE', `/api/printers/${id}`);

    for (const reply of [add, activate, remove]) {
      expect(reply.status).toBe(403);
      expect(reply.body.error).toContain(`${CONNECTION_PRESETS_API_ENV}=true`);
    }
    expect(retarget).not.toHaveBeenCalled();
    expect(deps.presets.list()).toHaveLength(2);
  });

  it('adds, switches and removes when turned on — without echoing a secret', async () => {
    const { deps, retarget, resetForPrinterSwitch } = makeDeps(true);

    const add = await call(deps, 'POST', '/api/printers', {
      name: 'B',
      ip: '198.51.100.20',
      password: PRESET_PASSWORD,
    });
    expect(add.status).toBe(201);
    expect(add.raw).not.toContain(PRESET_PASSWORD);
    const id = (add.body.preset as { id: string }).id;

    const activate = await call(deps, 'POST', `/api/printers/${id}/activate`);
    expect(activate.status).toBe(200);
    expect(activate.raw).not.toContain(PRESET_PASSWORD);
    expect(activate.raw).not.toContain(ENV_PASSWORD);
    expect(retarget).toHaveBeenCalledTimes(1);
    expect(resetForPrinterSwitch).toHaveBeenCalledTimes(1);

    expect((await call(deps, 'DELETE', `/api/printers/${id}`)).status).toBe(409);
    expect((await call(deps, 'POST', `/api/printers/${ENV_PRESET_ID}/activate`)).status).toBe(200);
    expect((await call(deps, 'DELETE', `/api/printers/${id}`)).status).toBe(200);
  });

  it('answers a malformed address with 400', async () => {
    const { deps } = makeDeps(true);
    const reply = await call(deps, 'POST', '/api/printers', { name: 'x', ip: '300.0.0.1' });
    expect(reply.status).toBe(400);
  });

  it('leaves every other URL to the rest of the router', async () => {
    const { deps } = makeDeps(true);
    expect((await call(deps, 'GET', '/api/status')).status).toBe(-1);
    expect((await call(deps, 'GET', '/api/printersX')).status).toBe(-1);
  });
});
