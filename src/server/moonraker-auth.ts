/**
 * Which Moonraker operations need the service API key (ELEG-25 plan §2, ELEG-142).
 *
 * The Moonraker protocol is mounted in four places, and all four use this one table:
 *
 *   - `/moonraker/*` on the main port (`moonraker-compat.ts`),
 *   - the dedicated `:7125` HTTP server (`moonraker-server.ts`, `handleHttp`),
 *   - the `:7125` WebSocket at `/websocket`, and
 *   - the `:7125` catch-all WebSocket upgrade (`/`, `/klippy`, …) — the same dispatcher.
 *
 * The WebSocket is the one that matters most: KlipperScreen, Fluidd and Mainsail send their
 * writes as JSON-RPC over it, not as HTTP.
 *
 * The decision itself is `authorize()` in `write-auth.ts` — this module only classifies.
 * **Classified by operation, not by verb**: `POST /printer/objects/query` is a read, and
 * every JSON-RPC call looks the same on the wire.
 *
 * **Default-deny on both transports.**
 *   - HTTP: any method other than GET/HEAD is a write unless it is in `HTTP_OPEN_WRITES`.
 *   - JSON-RPC: a method is open only if it is in `RPC_OPEN`; the dispatcher's write cases
 *     are in `RPC_GATED`. A name in neither is refused as "Method not found" before the
 *     dispatcher sees it, so a new `case` cannot run until someone classifies it here — the
 *     test that pins these tables also checks every `case` label is in one of them.
 *
 * **Deliberately open, and why** (the rule: gated = reaches the printer, printer files, the
 * print queue, or service configuration):
 *   - `server.connection.identify` — how a client presents `api_key` in the first place.
 *   - `access.*` — the truthful "no login, no tokens, no key handed out" answers (ELEG-26,
 *     ELEG-53). None of them grants anything.
 *   - `server.database.*` — the clients' own UI preferences in `moonraker-db.json`. They
 *     never reach the printer, and gating them would break read-only Mainsail and Fluidd.
 *     **Except the `webcams` namespace**: `server.webcams.post_item` writes there, so an
 *     open database write to it would be a way round that gated method.
 */

/** JSON-RPC methods that need no key: reads, plus the three open groups above. */
export const RPC_OPEN: ReadonlySet<string> = new Set([
  // Connection
  'server.connection.identify',
  'server.websocket.id',
  // Server / printer state
  'server.info',
  'server.config',
  'printer.info',
  'printer.objects.list',
  'printer.objects.query',
  'printer.objects.subscribe',
  'printer.gcode.help',
  'printer.query_endstops.status',
  'server.temperature_store',
  'server.gcode_store',
  // Files (reads; metascan and thumbnails only answer here, they write nothing)
  'server.files.list',
  'server.files.get_directory',
  'server.files.metadata',
  'server.files.roots',
  'server.files.metascan',
  'server.files.thumbnails',
  // Webcams, history, queue, machine, announcements — reads
  'server.webcams.list',
  'server.webcams.get_item',
  'server.history.list',
  'server.history.totals',
  'server.history.get_job',
  'server.job_queue.status',
  'machine.system_info',
  'machine.proc_stats',
  'machine.update.status',
  'server.announcements.list',
  'server.announcements.list_feeds',
  // access.* — truthful refusals and stubs; none grants anything
  'access.get_user',
  'access.oneshot_token',
  'access.login',
  'access.logout',
  'access.post_user',
  'access.delete_user',
  'access.user.password',
  'access.refresh_jwt',
  'access.users.list',
  'access.get_api_key',
  'access.post_api_key',
  'access.info',
  // server.database.* — UI preferences (see the `webcams` exception)
  'server.database.list',
  'server.database.get_item',
  'server.database.post_item',
  'server.database.delete_item',
]);

/** JSON-RPC methods the dispatcher implements that need the key. Pinned by the tests. */
export const RPC_GATED: ReadonlySet<string> = new Set([
  'printer.print.start',
  'printer.print.pause',
  'printer.print.resume',
  'printer.print.cancel',
  'printer.emergency_stop',
  'printer.gcode.script',
  'printer.restart',
  'printer.firmware_restart',
  'server.restart',
  'server.files.post_directory',
  'server.files.delete_directory',
  'server.files.move',
  'server.files.copy',
  'server.files.delete_file',
  'server.history.delete_job',
  'server.history.reset_totals',
  'server.job_queue.post_job',
  'server.job_queue.delete_job',
  'server.job_queue.pause',
  'server.job_queue.start',
  'server.job_queue.jump',
  'server.webcams.post_item',
  'server.webcams.delete_item',
  'server.announcements.update',
  'server.announcements.dismiss',
  'server.announcements.post_feed',
  'server.announcements.delete_feed',
  'server.logs.rollover',
  'machine.services.restart',
  'machine.services.start',
  'machine.services.stop',
  'machine.shutdown',
  'machine.reboot',
]);

/** Database namespaces whose writes are gated, because a gated method writes them too. */
const PROTECTED_DB_NAMESPACES: ReadonlySet<string> = new Set(['webcams']);

const DB_WRITES: ReadonlySet<string> = new Set([
  'server.database.post_item',
  'server.database.delete_item',
]);

/**
 * How the dispatcher must treat an RPC call:
 *   - `'unknown'` — in neither table: answer "Method not found" and run nothing;
 *   - `'write'`   — needs the key;
 *   - `'read'`    — open.
 */
export function classifyRpc(
  method: string,
  params: Record<string, unknown>,
): 'read' | 'write' | 'unknown' {
  if (RPC_GATED.has(method)) return 'write';
  if (!RPC_OPEN.has(method)) return 'unknown';
  if (DB_WRITES.has(method) && isProtectedDbNamespace(params.namespace)) return 'write';
  return 'read';
}

/**
 * HTTP writes that stay open: `objects/query` is a read sent as POST, database items are
 * UI preferences (minus `webcams`), and `/access/*` only ever refuses.
 */
const HTTP_OPEN_WRITES: ReadonlySet<string> = new Set([
  'POST /printer/objects/query',
  'POST /server/database/item',
  'DELETE /server/database/item',
  'POST /access/login',
  'POST /access/logout',
  'POST /access/refresh_jwt',
  'POST /access/api_key',
  'POST /access/user',
  'DELETE /access/user',
  'POST /access/user/password',
]);

/**
 * Whether an HTTP request to a Moonraker route is a write. `path` has any mount prefix
 * (`/moonraker`) already removed and no query string; `query` is the parsed query string,
 * which is where `DELETE /server/database/item` carries its namespace. A `POST` database
 * item carries its namespace in the body, which is not read here — so a `POST` to it is
 * classified by the caller once the body is parsed (`isProtectedDbNamespace`).
 */
export function isMoonrakerHttpWrite(
  method: string,
  path: string,
  query: Record<string, string>,
): boolean {
  if (method === 'GET' || method === 'HEAD') return false;
  if (!HTTP_OPEN_WRITES.has(`${method} ${path}`)) return true;
  if (method === 'DELETE' && path === '/server/database/item') {
    return isProtectedDbNamespace(query.namespace);
  }
  return false;
}

/** Whether a database namespace's writes need the key (see `PROTECTED_DB_NAMESPACES`). */
export function isProtectedDbNamespace(namespace: unknown): boolean {
  return PROTECTED_DB_NAMESPACES.has(String(namespace ?? ''));
}

/**
 * Moonraker's own refusal: `{code: 401, message: 'Unauthorized'}` — the JSON-RPC error and
 * the HTTP error body both use it, and it is what Mainsail's identify error path checks.
 * It never says anything about the key, right or wrong.
 */
export const MOONRAKER_UNAUTHORIZED = { code: 401, message: 'Unauthorized' } as const;
