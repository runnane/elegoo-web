/**
 * MCP (Model Context Protocol) server for the Elegoo CC2 printer.
 *
 * Exposes printer state as MCP resources and printer controls as MCP tools.
 * Uses Streamable HTTP transport mounted at /mcp on the existing HTTP server.
 *
 * Resources:
 *   printer://status      — Current printer state (temps, fans, progress)
 *   printer://files       — File listing on printer storage
 *   printer://history     — Print history summary
 *   printer://metrics     — Structured metrics snapshot
 *
 * Tools:
 *   get_printer_status    — Get current printer status summary
 *   get_temperatures      — Get current temperatures
 *   get_print_progress    — Get active print progress
 *   get_file_list         — List files on printer storage
 *   send_command          — Send a raw MQTT command to the printer
 *   set_temperature       — Set nozzle/bed temperature
 *   pause_print           — Pause the current print
 *   resume_print          — Resume a paused print
 *   stop_print            — Stop/cancel the current print
 *   set_fan_speed         — Set fan speed (0-100%)
 *   set_speed_mode        — Set print speed mode
 *   home_axes             — Home printer axes
 *   toggle_led            — Toggle LED on/off
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { IncomingMessage, ServerResponse } from 'http';
import type { StateStore } from './state-store.js';
import type { MqttBridge } from './mqtt-bridge.js';
import { STATUS_NAMES, SUB_STATUS_NAMES, SPEED_MODE_NAMES, EXCEPTION_NAMES } from '../types.js';
import { getLogger } from './logger.js';
import { randomUUID } from 'crypto';
import { z } from 'zod';

const log = getLogger('MCP');

function fanPct(speed: number): number {
  return Math.round((speed / 255) * 100);
}

/** Build a plain-text printer status summary (no markdown escaping) */
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
  lines.push(`Nozzle: ${s.extruder?.temperature ?? '?'}°C (target: ${s.extruder?.target ?? 0}°C)`);
  lines.push(`Bed: ${s.heater_bed?.temperature ?? '?'}°C (target: ${s.heater_bed?.target ?? 0}°C)`);
  if (s.ztemperature_sensor?.temperature) {
    lines.push(`Chamber: ${s.ztemperature_sensor.temperature}°C`);
  }

  if (ms?.status === 2 && ps) {
    const progress = ms.progress ?? 0;
    const remaining = ps.remaining_time_sec ?? 0;
    const h = Math.floor(remaining / 3600);
    const m = Math.floor((remaining % 3600) / 60);
    lines.push('');
    lines.push(`File: ${ps.filename || '?'}`);
    lines.push(`Progress: ${progress}%`);
    lines.push(`Layer: ${ps.current_layer ?? '?'} / ${ps.total_layer ?? store.fileTotalLayers ?? '?'}`);
    lines.push(`Remaining: ${h}h ${m}m`);
    lines.push(`Speed: ${speedName}`);
  }

  if (s.fans) {
    lines.push('');
    lines.push(`Part fan: ${fanPct(s.fans.fan?.speed ?? 0)}%, Aux fan: ${fanPct(s.fans.aux_fan?.speed ?? 0)}%, Case fan: ${fanPct(s.fans.box_fan?.speed ?? 0)}%`);
  }

  const exceptions = ms?.exception_status ?? [];
  if (exceptions.length > 0) {
    const names = exceptions.map((c: number) => EXCEPTION_NAMES[c] || `Code ${c}`);
    lines.push('');
    lines.push(`Errors: ${names.join(', ')}`);
  }

  return lines.join('\n');
}

export function createMcpServer(store: StateStore, bridge: MqttBridge): McpServer {
  const mcp = new McpServer(
    {
      name: 'elegoo-cc2',
      version: '1.0.0',
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
    },
  );

  // ── Resources ──────────────────────────────────────────────

  mcp.resource('printer-status', 'printer://status', {
    description: 'Current printer status including temperatures, fans, print progress, and errors',
  }, async () => ({
    contents: [{
      uri: 'printer://status',
      mimeType: 'text/plain',
      text: buildStatusText(store),
    }],
  }));

  mcp.resource('printer-files', 'printer://files', {
    description: 'List of files on the printer local storage',
  }, async () => {
    const files = store.files.map(f => ({
      name: f.filename,
      size: f.size,
      type: f.type,
      ...(f.create_time ? { created: new Date(f.create_time * 1000).toISOString() } : {}),
    }));
    return {
      contents: [{
        uri: 'printer://files',
        mimeType: 'application/json',
        text: JSON.stringify(files, null, 2),
      }],
    };
  });

  mcp.resource('printer-metrics', 'printer://metrics', {
    description: 'Structured metrics snapshot (temperatures, fans, position, filament usage, layer stats)',
  }, async () => {
    const s = store.status;
    const a = store.attributes;
    const ms = s?.machine_status;
    const ps = s?.print_status;
    const layers = store.layerTimes;
    const avgLayerDur = layers.length > 0
      ? layers.reduce((sum, l) => sum + l.duration, 0) / layers.length : null;

    const metrics = {
      connected: !!a,
      printer: a ? { model: a.machine_model, sn: a.sn, ip: a.ip } : null,
      status: STATUS_NAMES[ms?.status ?? -1] ?? 'Unknown',
      temperatures: {
        nozzle: s?.extruder?.temperature ?? null,
        nozzle_target: s?.extruder?.target ?? null,
        bed: s?.heater_bed?.temperature ?? null,
        bed_target: s?.heater_bed?.target ?? null,
        chamber: s?.ztemperature_sensor?.temperature ?? null,
      },
      print: ps ? {
        filename: ps.filename || null,
        progress: ms?.progress ?? null,
        current_layer: ps.current_layer,
        total_layer: ps.total_layer ?? store.fileTotalLayers ?? null,
        remaining_sec: ps.remaining_time_sec,
      } : null,
      filament_usage: store.getFilamentUsageArray(),
      layers: {
        count: layers.length,
        avg_duration_sec: avgLayerDur != null ? Math.round(avgLayerDur * 10) / 10 : null,
      },
    };
    return {
      contents: [{
        uri: 'printer://metrics',
        mimeType: 'application/json',
        text: JSON.stringify(metrics, null, 2),
      }],
    };
  });

  // ── Tools ──────────────────────────────────────────────────

  mcp.tool('get_printer_status', 'Get a human-readable summary of the current printer status', async () => ({
    content: [{ type: 'text' as const, text: buildStatusText(store) }],
  }));

  mcp.tool(
    'get_temperatures',
    'Get current nozzle, bed, and chamber temperatures',
    async () => {
      const s = store.status;
      if (!s) return { content: [{ type: 'text' as const, text: 'Printer not connected' }] };
      const temps = {
        nozzle: { current: s.extruder?.temperature, target: s.extruder?.target },
        bed: { current: s.heater_bed?.temperature, target: s.heater_bed?.target },
        chamber: { current: s.ztemperature_sensor?.temperature },
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(temps, null, 2) }] };
    },
  );

  mcp.tool(
    'get_print_progress',
    'Get active print job progress details',
    async () => {
      const s = store.status;
      if (!s) return { content: [{ type: 'text' as const, text: 'Printer not connected' }] };
      const ms = s.machine_status;
      if (ms?.status !== 2) {
        return { content: [{ type: 'text' as const, text: `Not printing. Status: ${STATUS_NAMES[ms?.status ?? 0] ?? 'Unknown'}` }] };
      }
      const ps = s.print_status;
      const info = {
        filename: ps?.filename,
        progress: ms.progress,
        current_layer: ps?.current_layer,
        total_layer: ps?.total_layer ?? store.fileTotalLayers,
        elapsed_sec: ps?.print_duration,
        remaining_sec: ps?.remaining_time_sec,
        speed_mode: SPEED_MODE_NAMES[s.gcode_move?.speed_mode ?? 1],
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(info, null, 2) }] };
    },
  );

  mcp.tool(
    'get_file_list',
    'List gcode files on the printer',
    {
      storage: z.string().describe('Storage media: "local" (default), "u-disk", or "sd-card"'),
    },
    async (args) => {
      const files = store.files.map(f => `${f.filename} (${(f.size / 1024).toFixed(0)} KB)`);
      if (files.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No files found (file list may not be loaded yet). The file list is fetched on connect.' }] };
      }
      return { content: [{ type: 'text' as const, text: files.join('\n') }] };
    },
  );

  mcp.tool(
    'set_temperature',
    'Set nozzle and/or bed temperature',
    {
      nozzle: z.number().optional().describe('Nozzle temperature in °C (0−300). Omit to leave unchanged.'),
      bed: z.number().optional().describe('Bed temperature in °C (0−120). Omit to leave unchanged.'),
    },
    async (args) => {
      if (!bridge.isConnected) return { content: [{ type: 'text' as const, text: 'Printer not connected' }], isError: true };
      const params: Record<string, unknown> = {};
      if (args.nozzle != null) {
        if (args.nozzle < 0 || args.nozzle > 300) return { content: [{ type: 'text' as const, text: 'Nozzle temperature must be 0−300°C' }], isError: true };
        params.extruder = args.nozzle;
      }
      if (args.bed != null) {
        if (args.bed < 0 || args.bed > 120) return { content: [{ type: 'text' as const, text: 'Bed temperature must be 0−120°C' }], isError: true };
        params.heater_bed = args.bed;
      }
      if (Object.keys(params).length === 0) return { content: [{ type: 'text' as const, text: 'Specify at least nozzle or bed temperature' }], isError: true };
      bridge.sendCommand(1028, params);
      return { content: [{ type: 'text' as const, text: `Temperature set: ${JSON.stringify(params)}` }] };
    },
  );

  mcp.tool('pause_print', 'Pause the current print job', async () => {
    if (!bridge.isConnected) return { content: [{ type: 'text' as const, text: 'Printer not connected' }], isError: true };
    bridge.sendCommand(1021, {});
    return { content: [{ type: 'text' as const, text: 'Pause command sent' }] };
  });

  mcp.tool('resume_print', 'Resume a paused print job', async () => {
    if (!bridge.isConnected) return { content: [{ type: 'text' as const, text: 'Printer not connected' }], isError: true };
    bridge.sendCommand(1023, {});
    return { content: [{ type: 'text' as const, text: 'Resume command sent' }] };
  });

  mcp.tool('stop_print', 'Stop/cancel the current print job', async () => {
    if (!bridge.isConnected) return { content: [{ type: 'text' as const, text: 'Printer not connected' }], isError: true };
    bridge.sendCommand(1022, {});
    return { content: [{ type: 'text' as const, text: 'Stop command sent' }] };
  });

  mcp.tool(
    'set_fan_speed',
    'Set fan speed as a percentage (0−100%)',
    {
      fan: z.string().describe('Fan name: "part" (model cooling), "aux" (auxiliary), or "case" (enclosure)'),
      speed: z.number().describe('Speed percentage 0−100'),
    },
    async (args) => {
      if (!bridge.isConnected) return { content: [{ type: 'text' as const, text: 'Printer not connected' }], isError: true };
      const pct = Math.max(0, Math.min(100, args.speed));
      const val = Math.round((pct / 100) * 255);
      const fanMap: Record<string, string> = { part: 'fan', aux: 'aux_fan', case: 'box_fan' };
      const key = fanMap[args.fan];
      if (!key) return { content: [{ type: 'text' as const, text: 'Fan must be "part", "aux", or "case"' }], isError: true };
      bridge.sendCommand(1030, { [key]: val });
      return { content: [{ type: 'text' as const, text: `Fan ${args.fan} set to ${pct}%` }] };
    },
  );

  mcp.tool(
    'set_speed_mode',
    'Set print speed mode',
    {
      mode: z.string().describe('Speed mode: "silent" (0), "balanced" (1), "sport" (2), or "ludicrous" (3)'),
    },
    async (args) => {
      if (!bridge.isConnected) return { content: [{ type: 'text' as const, text: 'Printer not connected' }], isError: true };
      const modeMap: Record<string, number> = { silent: 0, balanced: 1, sport: 2, ludicrous: 3 };
      const mode = modeMap[args.mode.toLowerCase()];
      if (mode == null) return { content: [{ type: 'text' as const, text: 'Mode must be "silent", "balanced", "sport", or "ludicrous"' }], isError: true };
      bridge.sendCommand(1031, { mode });
      return { content: [{ type: 'text' as const, text: `Speed mode set to ${args.mode}` }] };
    },
  );

  mcp.tool(
    'home_axes',
    'Home printer axes',
    {
      axes: z.string().describe('Axes to home: "xy", "z", or "xyz"'),
    },
    async (args) => {
      if (!bridge.isConnected) return { content: [{ type: 'text' as const, text: 'Printer not connected' }], isError: true };
      const valid = ['xy', 'z', 'xyz'];
      if (!valid.includes(args.axes)) return { content: [{ type: 'text' as const, text: 'Axes must be "xy", "z", or "xyz"' }], isError: true };
      bridge.sendCommand(1026, { homed_axes: args.axes });
      return { content: [{ type: 'text' as const, text: `Homing ${args.axes} axes` }] };
    },
  );

  mcp.tool(
    'toggle_led',
    'Turn the LED light on or off',
    {
      on: z.boolean().describe('true = on, false = off'),
    },
    async (args) => {
      if (!bridge.isConnected) return { content: [{ type: 'text' as const, text: 'Printer not connected' }], isError: true };
      bridge.sendCommand(1029, { power: args.on ? 1 : 0 });
      return { content: [{ type: 'text' as const, text: `LED ${args.on ? 'on' : 'off'}` }] };
    },
  );

  mcp.tool(
    'send_command',
    'Send a raw MQTT command to the printer (advanced). See CC2 protocol docs for method codes.',
    {
      method: z.number().describe('CC2 MQTT method code (e.g. 1001, 1002, 1028)'),
      params: z.string().describe('JSON string of command parameters (e.g. \'{"extruder": 210}\')'),
    },
    async (args) => {
      if (!bridge.isConnected) return { content: [{ type: 'text' as const, text: 'Printer not connected' }], isError: true };
      let params: Record<string, unknown>;
      try {
        params = JSON.parse(args.params);
      } catch {
        return { content: [{ type: 'text' as const, text: 'Invalid JSON in params' }], isError: true };
      }
      bridge.sendCommand(args.method, params);
      return { content: [{ type: 'text' as const, text: `Command sent: method=${args.method} params=${JSON.stringify(params)}` }] };
    },
  );

  log.info('MCP server configured with resources and tools');
  return mcp;
}

/** Manage per-session transports and handle /mcp requests */
const sessions = new Map<string, StreamableHTTPServerTransport>();

export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  store: StateStore,
  bridge: MqttBridge,
): Promise<void> {
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
