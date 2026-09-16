/**
 * The print queue's REST surface (ELEG-35).
 *
 * Driven with an in-memory request and response rather than a listening server, so this
 * file binds no port (see `.agents/gates.md` on why the gates stay port-free). The bridge
 * is a stub: "started" below means a recorded `sendCommand(1020, …)`, never a print.
 */

import { EventEmitter } from 'events';
import type { IncomingMessage, ServerResponse } from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrintQueue } from '../print-queue.js';
import { handlePrintQueueRequest } from '../print-queue-routes.js';

class StubPrinter extends EventEmitter {
  status: { machine_status: { status: number; sub_status: number } } = {
    machine_status: { status: 1, sub_status: 0 },
  };
}

let dir: string;
let printer: StubPrinter;
let starts: Array<Record<string, unknown>>;
let queue: PrintQueue;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eleg35-routes-'));
  printer = new StubPrinter();
  starts = [];
  queue = new PrintQueue(
    printer,
    {
      sendCommand: (method, params) => {
        if (method === 1020) starts.push(params);
      },
    },
    join(dir, 'print-queue.json'),
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Reply {
  handled: boolean;
  status: number;
  body: Record<string, unknown>;
}

function call(method: string, url: string, body?: unknown): Promise<Reply> {
  const chunks =
    body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const req = Object.assign(Readable.from(chunks), { method, url, headers: {} });
  return new Promise((resolve) => {
    let status = 0;
    const res = {
      writeHead(code: number) {
        status = code;
        return res;
      },
      end(payload?: string) {
        resolve({ handled: true, status, body: payload ? JSON.parse(payload) : {} });
      },
    };
    const handled = handlePrintQueueRequest(
      req as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      queue,
    );
    if (!handled) resolve({ handled: false, status: 0, body: {} });
  });
}

async function addJob(filename: string): Promise<string> {
  const reply = await call('POST', '/api/queue/items', { filename });
  return (reply.body.item as { id: string }).id;
}

describe('routing', () => {
  it('leaves every non-queue URL to the rest of the router', async () => {
    expect((await call('GET', '/api/status')).handled).toBe(false);
    expect((await call('GET', '/api/queued')).handled).toBe(false);
  });

  it('answers an unknown queue route with 404 rather than falling through', async () => {
    expect(await call('GET', '/api/queue/nope')).toMatchObject({ handled: true, status: 404 });
  });
});

describe('editing over REST', () => {
  it('adds a job and returns it from GET /api/queue', async () => {
    const added = await call('POST', '/api/queue/items', {
      filename: 'plates/fixture-a.gcode',
      source: 'u-disk',
    });
    expect(added.status).toBe(201);
    const listed = await call('GET', '/api/queue');
    expect(listed.status).toBe(200);
    const items = (listed.body.queue as { items: Array<{ filename: string; source: string }> })
      .items;
    expect(items).toEqual([
      expect.objectContaining({ filename: 'plates/fixture-a.gcode', source: 'u-disk' }),
    ]);
  });

  it('rejects a bad job or bad JSON with 400', async () => {
    expect((await call('POST', '/api/queue/items', { filename: '' })).status).toBe(400);
    expect((await call('POST', '/api/queue/items', '{nope')).status).toBe(400);
    expect((await call('POST', '/api/queue/items', [1, 2])).status).toBe(400);
  });

  it('removes a job, and 404s one that is not there', async () => {
    const id = await addJob('fixture-a.gcode');
    expect((await call('DELETE', `/api/queue/items/${id}`)).status).toBe(200);
    expect((await call('DELETE', `/api/queue/items/${id}`)).status).toBe(404);
  });

  it('reorders a job', async () => {
    await addJob('fixture-a.gcode');
    const b = await addJob('fixture-b.gcode');
    const moved = await call('POST', `/api/queue/items/${b}/move`, { index: 0 });
    expect(moved.status).toBe(200);
    const items = (moved.body.queue as { items: Array<{ filename: string }> }).items;
    expect(items.map((i) => i.filename)).toEqual(['fixture-b.gcode', 'fixture-a.gcode']);
    expect((await call('POST', `/api/queue/items/${b}/move`, { index: 'top' })).status).toBe(400);
  });

  it('clears the queue', async () => {
    await addJob('fixture-a.gcode');
    const cleared = await call('POST', '/api/queue/clear');
    expect((cleared.body.queue as { items: unknown[] }).items).toEqual([]);
  });
});

describe('POST /api/queue/start-next', () => {
  it('starts the head job with 202 when confirmed and the printer is idle', async () => {
    const id = await addJob('fixture-a.gcode');
    const reply = await call('POST', '/api/queue/start-next', {
      id,
      bedCleared: true,
      config: { delay_video: true },
    });
    expect(reply.status).toBe(202);
    expect(starts).toEqual([
      { storage_media: 'local', filename: 'fixture-a.gcode', config: { delay_video: true } },
    ]);
  });

  it('answers 400 and starts nothing without the bed-clear confirmation', async () => {
    const id = await addJob('fixture-a.gcode');
    const reply = await call('POST', '/api/queue/start-next', { id });
    expect(reply).toMatchObject({ status: 400, body: { code: 'confirmation_required' } });
    expect(starts).toHaveLength(0);
  });

  it('answers 409 and starts nothing while the printer is printing', async () => {
    const id = await addJob('fixture-a.gcode');
    printer.status = { machine_status: { status: 2, sub_status: 0 } };
    const reply = await call('POST', '/api/queue/start-next', { id, bedCleared: true });
    expect(reply).toMatchObject({ status: 409, body: { code: 'printing' } });
    expect(starts).toHaveLength(0);
  });

  it('answers 409 and starts nothing while the printer is paused', async () => {
    const id = await addJob('fixture-a.gcode');
    printer.status = { machine_status: { status: 2, sub_status: 2502 } };
    const reply = await call('POST', '/api/queue/start-next', { id, bedCleared: true });
    expect(reply).toMatchObject({ status: 409, body: { code: 'paused' } });
    expect(starts).toHaveLength(0);
  });

  it('resume never starts a job', async () => {
    await addJob('fixture-a.gcode');
    const reply = await call('POST', '/api/queue/resume');
    expect(reply.status).toBe(200);
    expect(starts).toHaveLength(0);
  });
});
