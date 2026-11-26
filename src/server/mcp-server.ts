/**
 * MCP (Model Context Protocol) server for the Elegoo CC2 printer.
 *
 * Lightweight design: every tool is a flat function with optional params and slim defaults.
 * All printer capabilities are exposed — read state, control printer, manage files.
 *
 * Resources:
 *   printer://status      — Full printer state summary
 *   printer://files       — File listing
 *   printer://metrics     — Structured metrics snapshot
 *   printer://events      — Event log (print starts, errors, layer changes)
 *   printer://system      — System info (firmware, SN, IP, disk)
 *   printer://zones       — Toolhead zone state
 *
 * Tools (all flat with optional params):
 *   status                — Printer status summary
 *   temperatures          — Current temps
 *   print_progress        — Active print details
 *   files                 — List files
 *   events                — Recent event log
 *   system_info           — Firmware/hardware info
 *   zones                 — Toolhead zone state
 *   layers                — Layer time history
 *   filament_usage        — Per-spool filament tracking
 *   canvas_info           — Canvas/AMS spool status
 *   set_temperature       — Set nozzle/bed temp
 *   fan                   — Set fan speed
 *   speed_mode            — Set speed mode
 *   led                   — Toggle LED
 *   home                  — Home axes
 *   move                  — Jog axis
 *   start_print           — Start a print
 *   pause_print           — Pause print
 *   resume_print          — Resume print
 *   stop_print            — Stop print
 *   auto_level            — Start auto bed leveling
 *   pid_calibrate         — PID auto-tune
 *   vibration_calibrate   — Resonance optimization
 *   self_check            — Combined self-test
 *   delete_file           — Delete a file
 *   load_filament         — Feed filament
 *   unload_filament       — Retract filament
 *   set_auto_refill       — Canvas auto-refill toggle
 *   emergency_stop        — Emergency stop
 *   enable_video_stream   — Enable camera MJPEG stream
 *   send_command          — Raw MQTT command (advanced)
 *
 * Write auth (ELEG-141): every tool from set_temperature down is registered through
 * `writeTool()` and needs SERVICE_API_KEY when one is configured. The read tools, the
 * resources, initialize and tools/list stay open. The key is checked on EVERY HTTP
 * request in `handleMcpRequest`, never once per session — see `WRITE_SCOPE`.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { IncomingMessage, ServerResponse } from 'http';
import type { StateStore } from './state-store.js';
import type { MqttBridge } from './mqtt-bridge.js';
import { STATUS_NAMES, SUB_STATUS_NAMES, SPEED_MODE_NAMES, EXCEPTION_NAMES } from '../types.js';
import { getLogger } from './logger.js';
import { authorize, extractKey, guardHttp, UNAUTHORIZED_MESSAGE } from './write-auth.js';
import { printBusyRefusal } from './print-guard.js';
import { randomUUID } from 'crypto';
import { z } from 'zod';

const log = getLogger('MCP');

const fanPct = (v: number) => Math.round((v / 255) * 100);
const txt = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const err = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });
const json = (obj: unknown) => txt(JSON.stringify(obj, null, 2));
const needConn = (bridge: MqttBridge) => (bridge.isConnected ? null : err('Printer not connected'));

/**
 * The scope `handleMcpRequest` grants a request that may write: the right key, or no key
 * configured at all. The SDK hands the request's `req.auth` to the tool handler as
 * `extra.authInfo`, **per request** — so a session opened with the key grants nothing to a
 * later request on the same session id that does not carry it.
 */
const WRITE_SCOPE = 'printer:write';

/** The tool error a gated tool returns without the key. Names the key; never contains it. */
const mcpWriteRefusal = (tool: string) =>
  err(`"${tool}" needs SERVICE_API_KEY. ${UNAUTHORIZED_MESSAGE}`);

/** True when the request this tool call arrived on was granted the write scope. */
function canWrite(extra: unknown): boolean {
  const auth = (extra as { authInfo?: AuthInfo } | undefined)?.authInfo;
  return !!auth?.scopes.includes(WRITE_SCOPE);
}

function buildStatusText(store: StateStore): string {
  const s = store.status;
  if (!s) return 'Printer not connected';
  const ms = s.machine_status;
  const ps = s.print_status;
  const statusName = STATUS_NAMES[ms?.status ?? 0] || 'Unknown';
  const subName = SUB_STATUS_NAMES[ms?.sub_status ?? 0] || '';
  const speedName = SPEED_MODE_NAMES[s.gcode_move?.speed_mode ?? 1] || '';
  const lines: string[] = [];
  lines.push(`Status: ${statusName}${subName ? ` — ${subName}` : ''}`);
  lines.push(`Nozzle: ${s.extruder?.temperature ?? '?'}°C → ${s.extruder?.target ?? 0}°C`);
  lines.push(`Bed: ${s.heater_bed?.temperature ?? '?'}°C → ${s.heater_bed?.target ?? 0}°C`);
  if (s.ztemperature_sensor?.temperature != null)
    lines.push(`Chamber: ${s.ztemperature_sensor.temperature}°C`);
  if (ms?.status === 2 && ps) {
    const rem = ps.remaining_time_sec ?? 0;
    lines.push(`File: ${ps.filename || '?'}`);
    lines.push(
      `Progress: ${ms.progress ?? 0}% | Layer: ${ps.current_layer ?? '?'}/${ps.total_layer ?? store.fileTotalLayers ?? '?'}`,
    );
    lines.push(
      `Remaining: ${Math.floor(rem / 3600)}h${Math.floor((rem % 3600) / 60)}m | Speed: ${speedName}`,
    );
  }
  if (s.fans) {
    lines.push(
      `Fans — Part: ${fanPct(s.fans.fan?.speed ?? 0)}% Aux: ${fanPct(s.fans.aux_fan?.speed ?? 0)}% Case: ${fanPct(s.fans.box_fan?.speed ?? 0)}%`,
    );
  }
  const exc = ms?.exception_status ?? [];
  if (exc.length)
    lines.push(`Errors: ${exc.map((c: number) => EXCEPTION_NAMES[c] || `Code ${c}`).join(', ')}`);
  lines.push(`Zone: ${store.zones.current}`);
  return lines.join('\n');
}

export function createMcpServer(store: StateStore, bridge: MqttBridge): McpServer {
  const mcp = new McpServer(
    { name: 'elegoo-cc2', version: '2.0.0' },
    { capabilities: { resources: {}, tools: {} } },
  );

  /**
   * `registerTool` for anything that changes the machine. The gate runs before the
   * handler — before `needConn`, before any `bridge` call — so a refused call has no
   * effect at all. The SDK passes `extra` as the LAST argument: `(args, extra)` for a tool
   * with an `inputSchema`, `(extra)` for one without, which is why it is read from the end.
   */
  const writeTool: McpServer['registerTool'] = (name, config, cb) => {
    const gated = (async (...a: unknown[]) => {
      if (!canWrite(a[a.length - 1])) return mcpWriteRefusal(name);
      return (cb as (...b: unknown[]) => unknown)(...a);
    }) as typeof cb;
    return mcp.registerTool(name, config, gated);
  };

  /**
   * The print guard (ELEG-176), as a tool error: `null` when the command may be sent. Every
   * tool that can move the head, drop a heater or change filament asks this before it
   * sends, so it never answers success for a command the guard would have dropped.
   */
  const refuseWhilePrinting = (tool: string, method: number, params: unknown) => {
    const refusal = printBusyRefusal(method, params, store.status);
    return refusal ? err(`"${tool}" refused: ${refusal}`) : null;
  };

  // ── Resources ──────────────────────────────────────────────

  mcp.registerResource(
    'printer-status',
    'printer://status',
    {
      description: 'Current printer status (temps, fans, progress, errors, zones)',
    },
    async () => ({
      contents: [{ uri: 'printer://status', mimeType: 'text/plain', text: buildStatusText(store) }],
    }),
  );

  mcp.registerResource(
    'printer-files',
    'printer://files',
    {
      description: 'Files on printer storage',
    },
    async () => ({
      contents: [
        {
          uri: 'printer://files',
          mimeType: 'application/json',
          text: JSON.stringify(
            store.files.map((f) => ({ name: f.filename, size: f.size, type: f.type })),
            null,
            2,
          ),
        },
      ],
    }),
  );

  mcp.registerResource(
    'printer-metrics',
    'printer://metrics',
    {
      description: 'Structured metrics (temps, fans, position, layers, filament)',
    },
    async () => {
      const s = store.status;
      const ms = s?.machine_status;
      const ps = s?.print_status;
      const layers = store.layerTimes;
      return {
        contents: [
          {
            uri: 'printer://metrics',
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                connected: !!store.attributes,
                status: STATUS_NAMES[ms?.status ?? -1] ?? 'Unknown',
                temperatures: {
                  nozzle: s?.extruder?.temperature ?? null,
                  nozzle_target: s?.extruder?.target ?? null,
                  bed: s?.heater_bed?.temperature ?? null,
                  bed_target: s?.heater_bed?.target ?? null,
                  chamber: s?.ztemperature_sensor?.temperature ?? null,
                },
                print:
                  ms?.status === 2 && ps
                    ? {
                        filename: ps.filename,
                        progress: ms.progress,
                        current_layer: ps.current_layer,
                        total_layer: ps.total_layer ?? store.fileTotalLayers,
                        remaining_sec: ps.remaining_time_sec,
                      }
                    : null,
                filament_usage: store.getFilamentUsageArray(),
                layers: {
                  count: layers.length,
                  avg_sec: layers.length
                    ? Math.round(
                        (layers.reduce((s, l) => s + l.duration, 0) / layers.length) * 10,
                      ) / 10
                    : null,
                },
                zone: store.zones.current,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  mcp.registerResource(
    'printer-events',
    'printer://events',
    {
      description: 'Recent event log (print starts, errors, layer changes)',
    },
    async () => ({
      contents: [
        {
          uri: 'printer://events',
          mimeType: 'application/json',
          text: JSON.stringify(store.getEventLog().slice(-50), null, 2),
        },
      ],
    }),
  );

  mcp.registerResource(
    'printer-system',
    'printer://system',
    {
      // Everything here comes from method 1001 (GET_ATTRIBUTES). It used to also carry
      // `systemInfo` from 1062, which was permanently null — 1062 answers
      // `{"error_code": 1100}` on this firmware, so the key was never once populated
      // (ELEG-55). "disk" went with it; disk usage comes from 1048, not this.
      description: 'System info (firmware, model, SN, IP)',
    },
    async () => ({
      contents: [
        {
          uri: 'printer://system',
          mimeType: 'application/json',
          text: JSON.stringify({ attributes: store.attributes }, null, 2),
        },
      ],
    }),
  );

  mcp.registerResource(
    'printer-zones',
    'printer://zones',
    {
      description: 'Toolhead zone detection state and history',
    },
    async () => ({
      contents: [
        {
          uri: 'printer://zones',
          mimeType: 'application/json',
          text: JSON.stringify(store.zones, null, 2),
        },
      ],
    }),
  );

  // ── Read-only tools ────────────────────────────────────────

  mcp.registerTool('status', { description: 'Get printer status summary' }, async () =>
    txt(buildStatusText(store)),
  );

  mcp.registerTool(
    'temperatures',
    { description: 'Get nozzle, bed, chamber temperatures' },
    async () => {
      const s = store.status;
      if (!s) return err('Printer not connected');
      return json({
        nozzle: { current: s.extruder?.temperature, target: s.extruder?.target },
        bed: { current: s.heater_bed?.temperature, target: s.heater_bed?.target },
        chamber: s.ztemperature_sensor?.temperature ?? null,
      });
    },
  );

  mcp.registerTool('print_progress', { description: 'Get active print progress' }, async () => {
    const s = store.status;
    if (!s) return err('Not connected');
    const ms = s.machine_status;
    if (ms?.status !== 2)
      return txt(`Not printing. Status: ${STATUS_NAMES[ms?.status ?? 0] ?? 'Unknown'}`);
    const ps = s.print_status;
    return json({
      filename: ps?.filename,
      progress: ms.progress,
      current_layer: ps?.current_layer,
      total_layer: ps?.total_layer ?? store.fileTotalLayers,
      elapsed_sec: ps?.print_duration,
      remaining_sec: ps?.remaining_time_sec,
      speed_mode: SPEED_MODE_NAMES[s.gcode_move?.speed_mode ?? 1],
    });
  });

  mcp.registerTool('files', { description: 'List gcode files on printer' }, async () => {
    if (!store.files.length) return txt('No files loaded yet');
    return txt(
      store.files.map((f) => `${f.filename} (${(f.size / 1024).toFixed(0)}KB)`).join('\n'),
    );
  });

  mcp.registerTool(
    'events',
    {
      description: 'Get recent event log entries',
      inputSchema: {
        count: z.number().optional().describe('Number of recent events (default 20)'),
      },
    },
    async (args) => json(store.getEventLog().slice(-(args.count ?? 20))),
  );

  mcp.registerTool(
    'system_info',
    { description: 'Get firmware, hardware, network info' },
    async () => {
      return json({ attributes: store.attributes });
    },
  );

  mcp.registerTool('zones', { description: 'Get toolhead zone state' }, async () =>
    json(store.zones),
  );

  mcp.registerTool(
    'layers',
    {
      description: 'Get layer time history',
      inputSchema: {
        last: z.number().optional().describe('Number of recent layers (default all)'),
      },
    },
    async (args) => {
      const l = store.layerTimes;
      return json(args.last ? l.slice(-args.last) : l);
    },
  );

  mcp.registerTool('filament_usage', { description: 'Get per-spool filament usage' }, async () =>
    json(store.getFilamentUsageArray()),
  );

  mcp.registerTool('canvas_info', { description: 'Get Canvas/AMS spool status' }, async () => {
    return store.canvas ? json(store.canvas) : txt('No Canvas data');
  });

  // ── Control tools — every one through writeTool() (ELEG-141) ─

  writeTool(
    'set_temperature',
    {
      description: 'Set nozzle and/or bed temperature',
      inputSchema: {
        nozzle: z.number().optional().describe('Nozzle °C (0-300)'),
        bed: z.number().optional().describe('Bed °C (0-120)'),
      },
    },
    async (args) => {
      const c = needConn(bridge);
      if (c) return c;
      const p: Record<string, unknown> = {};
      if (args.nozzle != null) {
        if (args.nozzle < 0 || args.nozzle > 300) return err('Nozzle: 0-300°C');
        p.extruder = args.nozzle;
      }
      if (args.bed != null) {
        if (args.bed < 0 || args.bed > 120) return err('Bed: 0-120°C');
        p.heater_bed = args.bed;
      }
      if (!Object.keys(p).length) return err('Specify nozzle and/or bed');
      // One frame carries both targets, so a mixed request is all or nothing.
      const busy = refuseWhilePrinting('set_temperature', 1028, p);
      if (busy) return busy;
      bridge.sendCommand(1028, p);
      return txt(`Temperature set: ${JSON.stringify(p)}`);
    },
  );

  writeTool(
    'fan',
    {
      description: 'Set fan speed',
      inputSchema: {
        name: z.enum(['part', 'aux', 'case']).describe('Fan: part, aux, or case'),
        speed: z.number().describe('Speed 0-100%'),
      },
    },
    async (args) => {
      const c = needConn(bridge);
      if (c) return c;
      const key = { part: 'fan', aux: 'aux_fan', case: 'box_fan' }[args.name];
      bridge.sendCommand(1030, {
        [key]: Math.round((Math.max(0, Math.min(100, args.speed)) / 100) * 255),
      });
      return txt(`${args.name} fan → ${args.speed}%`);
    },
  );

  writeTool(
    'speed_mode',
    {
      description: 'Set print speed mode',
      inputSchema: {
        mode: z.enum(['silent', 'balanced', 'sport', 'ludicrous']).describe('Speed mode'),
      },
    },
    async (args) => {
      const c = needConn(bridge);
      if (c) return c;
      const v = { silent: 0, balanced: 1, sport: 2, ludicrous: 3 }[args.mode];
      bridge.sendCommand(1031, { mode: v });
      return txt(`Speed → ${args.mode}`);
    },
  );

  writeTool(
    'led',
    {
      description: 'Toggle LED light',
      inputSchema: { on: z.boolean().describe('true=on, false=off') },
    },
    async (args) => {
      const c = needConn(bridge);
      if (c) return c;
      bridge.sendCommand(1029, { power: args.on ? 1 : 0 });
      return txt(`LED ${args.on ? 'on' : 'off'}`);
    },
  );

  writeTool(
    'home',
    {
      description: 'Home printer axes',
      inputSchema: {
        axes: z.enum(['xy', 'z', 'xyz']).optional().describe('Axes to home (default xyz)'),
      },
    },
    async (args) => {
      const c = needConn(bridge);
      if (c) return c;
      const p = { homed_axes: args.axes ?? 'xyz' };
      const busy = refuseWhilePrinting('home', 1026, p);
      if (busy) return busy;
      bridge.sendCommand(1026, p);
      return txt(`Homing ${args.axes ?? 'xyz'}`);
    },
  );

  writeTool(
    'move',
    {
      description: 'Jog a single axis',
      inputSchema: {
        axis: z.enum(['x', 'y', 'z']).describe('Axis'),
        distance: z.number().describe('Distance in mm (negative for reverse)'),
      },
    },
    async (args) => {
      const c = needConn(bridge);
      if (c) return c;
      const p = { axes: args.axis, distance: args.distance };
      const busy = refuseWhilePrinting('move', 1027, p);
      if (busy) return busy;
      bridge.sendCommand(1027, p);
      return txt(`Moving ${args.axis} ${args.distance}mm`);
    },
  );

  writeTool(
    'start_print',
    {
      description: 'Start printing a file',
      inputSchema: {
        filename: z.string().describe('Filename to print'),
        source: z.enum(['local', 'u-disk']).optional().describe('Storage (default local)'),
      },
    },
    async (args) => {
      const c = needConn(bridge);
      if (c) return c;
      bridge.sendCommand(1020, { filename: args.filename, storage_media: args.source ?? 'local' });
      return txt(`Starting: ${args.filename}`);
    },
  );

  writeTool('pause_print', { description: 'Pause current print' }, async () => {
    const c = needConn(bridge);
    if (c) return c;
    bridge.sendCommand(1021, {});
    return txt('Paused');
  });

  writeTool('resume_print', { description: 'Resume paused print' }, async () => {
    const c = needConn(bridge);
    if (c) return c;
    bridge.sendCommand(1023, {});
    return txt('Resumed');
  });

  writeTool('stop_print', { description: 'Stop/cancel current print' }, async () => {
    const c = needConn(bridge);
    if (c) return c;
    bridge.sendCommand(1022, {});
    return txt('Stopped');
  });

  writeTool(
    'emergency_stop',
    { description: 'Emergency stop — immediately halts printer' },
    async () => {
      const c = needConn(bridge);
      if (c) return c;
      bridge.sendCommand(1007, {});
      return txt('EMERGENCY STOP sent');
    },
  );

  writeTool('auto_level', { description: 'Start auto bed leveling' }, async () => {
    const c = needConn(bridge);
    if (c) return c;
    const busy = refuseWhilePrinting('auto_level', 1032, {});
    if (busy) return busy;
    bridge.sendCommand(1032, {});
    return txt('Auto-leveling started');
  });

  writeTool('pid_calibrate', { description: 'Start PID auto-tune' }, async () => {
    const c = needConn(bridge);
    if (c) return c;
    const busy = refuseWhilePrinting('pid_calibrate', 1034, {});
    if (busy) return busy;
    bridge.sendCommand(1034, {});
    return txt('PID calibration started');
  });

  writeTool('vibration_calibrate', { description: 'Start resonance optimization' }, async () => {
    const c = needConn(bridge);
    if (c) return c;
    const busy = refuseWhilePrinting('vibration_calibrate', 1033, {});
    if (busy) return busy;
    bridge.sendCommand(1033, {});
    return txt('Vibration calibration started');
  });

  writeTool(
    'self_check',
    {
      description: 'Run combined self-test',
      inputSchema: {
        ringing: z.boolean().optional().describe('Include resonance test (default true)'),
        pid: z.boolean().optional().describe('Include PID test (default true)'),
        leveling: z.boolean().optional().describe('Include bed leveling (default true)'),
      },
    },
    async (args) => {
      const c = needConn(bridge);
      if (c) return c;
      const p = {
        ringing_optimize: args.ringing ?? true,
        pid_check: args.pid ?? true,
        auto_bed_leveling: args.leveling ?? true,
      };
      const busy = refuseWhilePrinting('self_check', 1035, p);
      if (busy) return busy;
      bridge.sendCommand(1035, p);
      return txt('Self-check started');
    },
  );

  writeTool(
    'delete_file',
    {
      description: 'Delete a file from printer storage',
      inputSchema: {
        path: z.string().describe('File path (e.g. /model.gcode)'),
        source: z.enum(['local', 'u-disk']).optional().describe('Storage (default local)'),
      },
    },
    async (args) => {
      const c = needConn(bridge);
      if (c) return c;
      bridge.sendCommand(1047, { storage_media: args.source ?? 'local', file_path: args.path });
      return txt(`Deleted: ${args.path}`);
    },
  );

  writeTool('load_filament', { description: 'Feed/load filament into extruder' }, async () => {
    const c = needConn(bridge);
    if (c) return c;
    const busy = refuseWhilePrinting('load_filament', 1024, {});
    if (busy) return busy;
    bridge.sendCommand(1024, {});
    return txt('Loading filament');
  });

  writeTool(
    'unload_filament',
    { description: 'Retract/unload filament from extruder' },
    async () => {
      const c = needConn(bridge);
      if (c) return c;
      const busy = refuseWhilePrinting('unload_filament', 1025, {});
      if (busy) return busy;
      bridge.sendCommand(1025, {});
      return txt('Unloading filament');
    },
  );

  writeTool(
    'set_auto_refill',
    {
      description: 'Enable/disable Canvas auto-refill',
      inputSchema: { enabled: z.boolean().describe('true=enable, false=disable') },
    },
    async (args) => {
      const c = needConn(bridge);
      if (c) return c;
      bridge.sendCommand(2004, { auto_refill: args.enabled });
      return txt(`Auto-refill ${args.enabled ? 'enabled' : 'disabled'}`);
    },
  );

  writeTool(
    'enable_video_stream',
    {
      description: 'Enable camera MJPEG stream via SDCP',
      inputSchema: {
        method: z.enum(['sdcp', 'mqtt']).optional().describe('Method: sdcp (default) or mqtt'),
      },
    },
    async (args) => {
      const c = needConn(bridge);
      if (c) return c;
      if ((args.method ?? 'sdcp') === 'sdcp') {
        const result = await bridge.enableVideoStreamSDCP();
        return result.success
          ? txt(`Stream enabled${result.videoUrl ? ` — URL: ${result.videoUrl}` : ''}`)
          : err(`SDCP failed: ${result.error}`);
      }
      bridge.enableVideoStreamMQTT();
      return txt('MQTT 1054 Enable=1 sent — check log for response');
    },
  );

  // Always gated: it sends any method number, reads and writes alike.
  writeTool(
    'send_command',
    {
      description: 'Send raw MQTT command (advanced)',
      inputSchema: {
        method: z.number().describe('CC2 method code (e.g. 1001, 1028)'),
        params: z.string().optional().describe('JSON params string (default "{}")'),
      },
    },
    async (args) => {
      const c = needConn(bridge);
      if (c) return c;
      let p: Record<string, unknown>;
      try {
        p = JSON.parse(args.params ?? '{}');
      } catch {
        return err('Invalid JSON');
      }
      const busy = refuseWhilePrinting('send_command', args.method, p);
      if (busy) return busy;
      bridge.sendCommand(args.method, p);
      return txt(`Sent method=${args.method} params=${JSON.stringify(p)}`);
    },
  );

  log.info('MCP server configured (6 resources, 31 tools)');
  return mcp;
}

/** Manage per-session transports and handle /mcp requests */
const sessions = new Map<string, StreamableHTTPServerTransport>();

/**
 * `serviceApiKey` is read on every call (the caller passes `config.serviceApiKey`), and the
 * key is checked on every request — initialize, a reused session, GET and DELETE alike:
 *
 *   - a presented but wrong key → HTTP 401, here, before the transport sees the request;
 *   - the right key, or no key configured → `req.auth` carries `WRITE_SCOPE`, which the
 *     SDK passes to this request's tool calls as `extra.authInfo`;
 *   - no key presented → no scope: reads and tools/list work, `writeTool()`s refuse.
 *
 * `req.auth` holds a constant token, never the presented key.
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  store: StateStore,
  bridge: MqttBridge,
  serviceApiKey: string,
): Promise<void> {
  if (!guardHttp(req, res, serviceApiKey, false)) return;
  const scopes = authorize(serviceApiKey, extractKey(req), true) === 'ok' ? [WRITE_SCOPE] : [];
  (req as IncomingMessage & { auth?: AuthInfo }).auth = {
    token: 'service-api-key',
    clientId: 'elegoo-web',
    scopes,
  };

  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (req.method === 'GET' || req.method === 'DELETE') {
    // GET = SSE stream, DELETE = close session
    if (sessionId && sessions.has(sessionId)) {
      const transport = sessions.get(sessionId)!;
      await transport.handleRequest(req, res);
      if (req.method === 'DELETE') {
        sessions.delete(sessionId);
        log.info(`MCP session closed: ${sessionId}`);
      }
      return;
    }
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No valid session. Send an initialize request first.' }));
    return;
  }

  // POST request
  if (req.method === 'POST') {
    // Check if there's an existing session
    if (sessionId && sessions.has(sessionId)) {
      const transport = sessions.get(sessionId)!;
      await transport.handleRequest(req, res);
      return;
    }

    // New session — create transport + server
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        sessions.delete(sid);
        log.info(`MCP session closed: ${sid}`);
      }
    };

    const mcp = createMcpServer(store, bridge);
    await mcp.connect(transport);

    // Handle the current request (the initialize message)
    await transport.handleRequest(req, res);

    // Store session for future requests
    const newSessionId = transport.sessionId;
    if (newSessionId) {
      sessions.set(newSessionId, transport);
      log.info(`MCP session created: ${newSessionId}`);
    }
    return;
  }

  // Unsupported method
  res.writeHead(405, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Method not allowed' }));
}
