/**
 * The CC2 MQTT methods the Help tab documents (ELEG-182). Data, not markup, so
 * `src/__tests__/help-mqtt-methods.test.ts` can pin every number to the code that sends it.
 *
 * Not `log-methods.ts`: that is a display label for the log viewer, not an authority
 * (AGENTS.md). The authority for a row here is the sending code — `controls.ts`,
 * `mcp-server.ts`, `printer-commands.ts` — and the test names the line it holds each row to.
 */
export interface MqttMethod {
  method: number;
  name: string;
  description: string;
}

export const MQTT_METHODS: readonly MqttMethod[] = [
  {
    method: 1001,
    name: 'Get Attributes',
    description: 'Printer hostname, model, SN, firmware versions',
  },
  {
    method: 1002,
    name: 'Get Status',
    description: 'Full status snapshot (temps, fans, position, print state)',
  },
  { method: 1007, name: 'Emergency Stop', description: 'Abort immediately (no resume)' },
  { method: 1020, name: 'Print Control', description: 'Start print (filename, storage_media)' },
  { method: 1021, name: 'Pause Print', description: 'Pause current job' },
  { method: 1022, name: 'Stop Print', description: 'Cancel/stop current job' },
  { method: 1023, name: 'Resume Print', description: 'Resume paused job' },
  { method: 1024, name: 'Load Filament', description: 'Feed filament' },
  { method: 1025, name: 'Unload Filament', description: 'Retract filament' },
  { method: 1026, name: 'Home Axes', description: 'Home specified axes (homed_axes: x/y/z)' },
  { method: 1027, name: 'Move Axis', description: 'Jog axes (axes, distance in mm)' },
  {
    method: 1028,
    name: 'Set Temperature',
    description: 'Set nozzle (extruder) / bed (heater_bed) target temps',
  },
  { method: 1029, name: 'Set LED', description: 'Toggle LED on/off (power: 0/1)' },
  {
    method: 1030,
    name: 'Set Fan Speed',
    description: 'Set part (fan) / aux (aux_fan) / case (box_fan) fan speed, 0-255',
  },
  {
    method: 1031,
    name: 'Set Speed Mode',
    description: 'Speed profile (silent/balanced/sport/ludicrous)',
  },
  { method: 1032, name: 'Auto Level', description: 'Bed auto-levelling routine' },
  { method: 1033, name: 'Vibration Calibration', description: 'Input-shaper calibration' },
  { method: 1034, name: 'PID Calibration', description: 'Heater PID tuning' },
  { method: 1035, name: 'Self Check', description: 'Printer self-check routine' },
  { method: 1044, name: 'List Files', description: 'Get file list from storage' },
  {
    method: 1045,
    name: 'Get Thumbnail',
    description: 'Base64 PNG thumbnail (uses file_name)',
  },
  {
    method: 1046,
    name: 'Get File Detail',
    description: 'File metadata (uses filename)',
  },
  { method: 1047, name: 'Delete File', description: 'Delete file(s) from storage' },
  { method: 1048, name: 'Get Capacity', description: 'Storage total/free/used bytes' },
  { method: 1054, name: 'Live Stream', description: 'Enable the video stream (Enable: 1)' },
  { method: 2004, name: 'Auto Refill', description: 'Canvas auto-refill on/off' },
  { method: 2005, name: 'Canvas Status', description: 'AMS/spool slot status' },
  { method: 6000, name: 'Status Event', description: 'Async status update push from printer' },
];
