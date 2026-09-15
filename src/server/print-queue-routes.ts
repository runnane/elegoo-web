/**
 * REST surface for the print queue (ELEG-35).
 *
 *   GET    /api/queue                  — the queue
 *   POST   /api/queue/items            — { filename, source? } add to the end
 *   DELETE /api/queue/items/:id        — remove one
 *   POST   /api/queue/items/:id/move   — { index } reorder
 *   POST   /api/queue/clear            — empty the waiting list
 *   POST   /api/queue/resume           — release a hold (never starts a job)
 *   POST   /api/queue/start-next       — { id, bedCleared: true, config? } start the head
 *
 * **`start-next` is a printer command, and this service has no authentication**
 * (`.agents/security.md`). Anyone who can reach the port can call it, exactly as they can
 * press the existing Print button or call `/mcp`'s `start_print`. The refusals in
 * `PrintQueue.startNext` narrow *when* it acts; they are not access control.
 *
 * Mounted by `rest-api.ts` after its CORS block, so these routes get the same policy as
 * every other `/api/*` route.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { PrintQueue, StartRefusal } from './print-queue.js';

const MAX_BODY_BYTES = 64 * 1024;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Read a JSON object body. An empty body is `{}`; anything else malformed is a 400. */
function withBody(
  req: IncomingMessage,
  res: ServerResponse,
  handle: (body: Record<string, unknown>) => void,
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let aborted = false;
  req.on('data', (chunk: Buffer) => {
    if (aborted) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      aborted = true;
      json(res, 413, { error: 'Request body too large' });
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (aborted) return;
    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    if (raw === '') {
      handle({});
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      json(res, 400, { error: 'Invalid JSON' });
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      json(res, 400, { error: 'Expected a JSON object' });
      return;
    }
    handle(parsed as Record<string, unknown>);
  });
}

/** A refusal the human can fix by confirming is a 400; the printer's state is a 409. */
function refusalStatus(code: StartRefusal): number {
  return code === 'confirmation_required' ? 400 : 409;
}

/** Returns true when the request was a queue route and has been answered. */
export function handlePrintQueueRequest(
  req: IncomingMessage,
  res: ServerResponse,
  queue: PrintQueue,
): boolean {
  const path = (req.url || '').split('?')[0];
  if (path !== '/api/queue' && !path.startsWith('/api/queue/')) return false;
  const method = req.method || 'GET';

  if (path === '/api/queue' && method === 'GET') {
    json(res, 200, { queue: queue.snapshot() });
    return true;
  }

  if (path === '/api/queue/items' && method === 'POST') {
    withBody(req, res, (body) => {
      const result = queue.add(body.filename, body.source ?? 'local');
      if (result.ok) json(res, 201, { item: result.item, queue: queue.snapshot() });
      else json(res, 400, { error: result.message });
    });
    return true;
  }

  const itemRoute = /^\/api\/queue\/items\/([A-Za-z0-9-]{1,64})(\/move)?$/.exec(path);
  if (itemRoute && !itemRoute[2] && method === 'DELETE') {
    if (queue.remove(itemRoute[1])) json(res, 200, { queue: queue.snapshot() });
    else json(res, 404, { error: 'No such queued job' });
    return true;
  }
  if (itemRoute && itemRoute[2] && method === 'POST') {
    const id = itemRoute[1];
    withBody(req, res, (body) => {
      if (!Number.isInteger(body.index)) {
        json(res, 400, { error: 'index must be an integer' });
        return;
      }
      if (queue.move(id, body.index as number)) json(res, 200, { queue: queue.snapshot() });
      else json(res, 404, { error: 'No such queued job' });
    });
    return true;
  }

  if (path === '/api/queue/clear' && method === 'POST') {
    queue.clear();
    json(res, 200, { queue: queue.snapshot() });
    return true;
  }

  if (path === '/api/queue/resume' && method === 'POST') {
    queue.resume();
    json(res, 200, { queue: queue.snapshot() });
    return true;
  }

  if (path === '/api/queue/start-next' && method === 'POST') {
    withBody(req, res, (body) => {
      const result = queue.startNext({
        id: body.id,
        bedCleared: body.bedCleared,
        config: body.config,
      });
      if (result.ok) {
        json(res, 202, { ok: true, dispatched: result.item, queue: queue.snapshot() });
      } else {
        json(res, refusalStatus(result.code), {
          ok: false,
          code: result.code,
          error: result.message,
          queue: queue.snapshot(),
        });
      }
    });
    return true;
  }

  json(res, 404, { error: 'Unknown queue route' });
  return true;
}
