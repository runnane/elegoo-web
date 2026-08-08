/** CC2 printer protocol types */

export interface PrinterAttributes {
  hostname: string;
  machine_model: string;
  sn: string;
  ip: string;
  protocol_version: string;
  hardware_version: string;
  software_version: {
    ota_version: string;
    mcu_version: string;
    soc_version: string;
  };
}

export interface MachineStatus {
  status: number;
  sub_status: number;
  sub_status_reason_code?: number;
  exception_status: number[];
  progress: number;
}

export interface PrintStatus {
  filename: string;
  uuid: string;
  current_layer: number;
  total_layer?: number;
  print_duration: number;
  total_duration: number;
  remaining_time_sec: number;
  progress?: number;
  state?: string;
  enable?: boolean;
  bed_mesh_detect?: boolean;
  filament_detect?: boolean;
}

export interface Extruder {
  temperature: number;
  target: number;
  filament_detect_enable: number;
  filament_detected: number;
}

export interface HeaterBed {
  temperature: number;
  target: number;
}

export interface ChamberSensor {
  temperature: number;
  measured_max_temperature: number;
  measured_min_temperature: number;
}

export interface FanInfo {
  speed: number;
  rpm?: number;
}

export interface Fans {
  fan: FanInfo;
  aux_fan: FanInfo;
  box_fan: FanInfo;
  heater_fan: FanInfo;
  controller_fan: FanInfo;
}

export interface GcodeMove {
  x: number;
  y: number;
  z: number;
  e?: number;
  extruder?: number;
  speed: number;
  speed_mode: number;
}

export interface Led {
  status: number;
}

export interface ExternalDevice {
  camera: boolean;
  u_disk: boolean;
  type: string;
}

export interface CanvasTray {
  tray_id: number;
  brand: string;
  filament_type: string;
  filament_name: string;
  filament_color: string;
  min_nozzle_temp: number;
  max_nozzle_temp: number;
  status: number; // 0=empty, 1=loaded, 2=active
}

export interface CanvasUnit {
  canvas_id: number;
  connected: number;
  tray_list: CanvasTray[];
}

export interface CanvasInfo {
  active_canvas_id: number;
  active_tray_id: number;
  auto_refill: boolean;
  canvas_list: CanvasUnit[];
}

export interface PrinterStatus {
  machine_status: MachineStatus;
  print_status: PrintStatus;
  extruder: Extruder;
  heater_bed: HeaterBed;
  ztemperature_sensor: ChamberSensor;
  fans: Fans;
  gcode_move: GcodeMove;
  led: Led;
  tool_head: { homed_axes: string };
  external_device: ExternalDevice;
}

export interface FileEntry {
  filename: string;
  type: string;
  size: number;
  create_time?: number;
  print_time?: number;
  layer?: number;
  total_filament_used?: number;
}

// Machine status codes (We enum from official app)
export const STATUS_NAMES: Record<number, string> = {
  0: 'Initializing',
  1: 'Idle',
  2: 'Printing',
  3: 'Loading Filament',
  4: 'Unloading Filament',
  5: 'Auto Leveling',
  6: 'PID Calibrating',
  7: 'Resonance Testing',
  8: 'Self Checking',
  9: 'Updating',
  10: 'Homing',
  11: 'File Transferring',
  12: 'Creating Timelapse',
  13: 'Extruder Operating',
  14: 'Emergency Stop',
  15: 'Power Loss Recovery',
};

// Sub-status codes (xe enum from official app)
export const SUB_STATUS_NAMES: Record<number, string> = {
  0: '',
  // Environment
  1041: 'Environment Too Cold',
  // Nozzle / Bed temperature
  1045: 'Preheating Nozzle',
  1096: 'Cooling Nozzle',
  1405: 'Preheating Bed',
  1906: 'Cooling Bed',
  // Chamber
  1070: 'Cooling Chamber',
  1071: 'Chamber Cooling Complete',
  1072: 'Chamber Cooling Failed',
  // PID calibration
  1053: 'PID Preheating',
  1054: 'PID Detecting',
  1055: 'PID Calibration Complete',
  1056: 'PID Calibration Failed',
  // Extruder (mono/direct drive)
  1061: 'Extruder Loading',
  1062: 'Extruder Unloading',
  1063: 'Extruder Load Complete',
  1064: 'Extruder Unload Complete',
  1066: 'Filament Change',
  1133: 'Heating Nozzle',
  1134: 'Insert Filament',
  1135: 'Biting Filament',
  1136: 'Bite Filament Done',
  1143: 'Cutting Filament',
  1144: 'Ejecting Filament',
  1145: 'Eject Filament Complete',
  // Canvas (AMS) — Load
  1150: 'Canvas: Load Start',
  1151: 'Canvas: Heating Nozzle',
  1152: 'Canvas: Insert Filament',
  1153: 'Canvas: Cutting Filament',
  1154: 'Canvas: Retracting Filament',
  1155: 'Canvas: Feeding Filament',
  1156: 'Canvas: Flushing Filament',
  1157: 'Canvas: Load Complete',
  1158: 'Canvas: Load Failed',
  // Canvas (AMS) — Unload
  1160: 'Canvas: Unload Start',
  1161: 'Canvas: Heating Nozzle',
  1162: 'Canvas: Checking Filament',
  1163: 'Canvas: Cutting Filament',
  1164: 'Canvas: Retracting Filament',
  1165: 'Canvas: Unload Complete',
  1166: 'Canvas: Unload Failed',
  // Printing lifecycle
  2075: 'Printing',
  2077: 'Print Complete',
  // Resume / Pause / Stop
  2401: 'Resuming',
  2402: 'Resume Complete',
  2405: 'Power Loss Resume',
  2406: 'Power Loss Resume Complete',
  2501: 'Pausing',
  2502: 'Paused',
  2503: 'Stopping',
  2504: 'Stopped',
  2505: 'Filament Interruption',
  // OTA / Firmware
  2601: 'OTA Info Updating',
  2603: 'Initialize Complete',
  2701: 'OTA Downloading',
  2702: 'OTA Extracting',
  2703: 'OTA Updating',
  2704: 'OTA Complete',
  2705: 'OTA Failed',
  // Homing
  2801: 'Homing',
  2802: 'Homing Done',
  // Leveling
  2901: 'Auto Leveling',
  2902: 'Leveling Done',
  // File transfer
  3000: 'File Sending',
  3001: 'File Send Complete',
  3010: 'File Copying',
  3011: 'File Copy Complete',
  // Timelapse
  3020: 'Timelapse Processing',
  3021: 'Timelapse Complete',
  3022: 'Timelapse Failed',
  // Resonance / Vibration
  5932: 'Accelerometer Normal',
  5933: 'Accelerometer Error',
  5934: 'Resonance Optimizing',
  5935: 'Resonance Test Complete',
  5936: 'Resonance Test Failed',
};

export const SPEED_MODE_NAMES: Record<number, string> = {
  0: 'Silent',
  1: 'Balanced',
  2: 'Sport',
  3: 'Ludicrous',
};

/**
 * Returns true if the sub_status indicates a filament change operation
 * (Canvas/AMS load/unload, extruder swap, nozzle preheat for swap, etc.)
 * Used to suppress false filament-runout alerts and AI stall detection.
 */
export function isFilamentChangeSubStatus(subStatus: number): boolean {
  // Extruder load/unload (1061-1066)
  if (subStatus >= 1061 && subStatus <= 1066) return true;
  // Canvas (AMS) load (1150-1158) and unload (1160-1166)
  if (subStatus >= 1150 && subStatus <= 1166) return true;
  // Nozzle preheat during filament swap (1045, 1133-1145)
  if (subStatus === 1045) return true;
  if (subStatus >= 1133 && subStatus <= 1145) return true;
  // Filament interruption (2505)
  if (subStatus === 2505) return true;
  return false;
}

// ─── Power loss recovery ─────────────────────────────────────────────

/** Machine status the CC2 reports after a power loss with a print in progress. */
export const STATUS_POWER_LOSS_RECOVERY = 15;

/** Sub-statuses the printer moves through once a recovery has been started. */
const SUB_POWER_LOSS_RESUMING = 2405;
const SUB_POWER_LOSS_RESUMED = 2406;

/**
 * Where a power-loss recovery has got to.
 *
 * The distinction that matters is `awaiting_decision` versus the rest. Status 15 alone
 * means the printer is sitting on a half-finished job with nobody having told it what
 * to do; once 2405 arrives the decision has been made and prompting again would invite
 * a second resume on a print already resuming.
 */
export type PowerLossState = 'none' | 'awaiting_decision' | 'resuming' | 'resumed';

export function powerLossState(
  status: number | undefined | null,
  subStatus: number | undefined | null,
): PowerLossState {
  if (status !== STATUS_POWER_LOSS_RECOVERY) return 'none';
  if (subStatus === SUB_POWER_LOSS_RESUMING) return 'resuming';
  if (subStatus === SUB_POWER_LOSS_RESUMED) return 'resumed';
  return 'awaiting_decision';
}

// ─── Command result codes (`error_code` on a method response) ────────
//
// Distinct from EXCEPTION_NAMES below: an *exception* is a hardware fault the printer
// reports about itself, while these come back on the response to a command we sent and
// say what happened to that command. Names and numbers are from the official app's `hh`
// enum, transcribed in `data/CC2_PROTOCOL_REFERENCE.md` §4.
export const ERROR_CODE_NAMES: Record<number, string> = {
  0: 'Success',
  109: 'Filament runout',
  1000: 'Auth token invalid',
  1001: 'Unknown method',
  1002: 'Cannot open folder',
  1003: 'Invalid parameter',
  1004: 'File write failed',
  1005: 'Token update failed',
  1006: 'Failed to send update to MCU',
  1007: 'Cannot delete file',
  1008: 'Empty response',
  1009: 'Printer busy',
  1010: 'Not currently printing',
  1011: 'File copy failed',
  1012: 'Task not found',
  1013: 'Database operation failed',
  1014: 'Invalid gcode file',
  1015: 'No thumbnail available',
  1016: 'Thumbnail parse failed',
  1017: 'USB drive not detected',
  1018: 'USB drive removed',
  1019: 'Timelapse generation failed',
  1020: 'Timelapse video does not exist',
  1021: 'File not found',
  1026: 'No bed mesh data — run auto-levelling first',
  9999: 'Unknown error',
};

/**
 * What happened to a command, as far as the UI needs to care.
 *
 * The split that matters is `busy` vs the rest. The printer returns 1009 whenever it
 * cannot accept a command *right now* — mid-filament-change, during calibration, with
 * another command in flight — and that is not a failure: the same command will work in
 * a moment. Showing it as an error trains people to ignore real errors, and showing
 * nothing at all (which is what happened before ELEG-40) lets them conclude the command
 * worked.
 */
export type CommandOutcome = 'ok' | 'busy' | 'rejected' | 'error';

/** Transient — the identical command is expected to succeed once the printer is free. */
export const BUSY_ERROR_CODES = new Set([1009]);

/**
 * The command was understood and refused, and repeating it unchanged will be refused
 * again until something else changes. Worth telling the user *what* to change, which is
 * why these are not lumped in with `error`.
 */
export const REJECTED_ERROR_CODES = new Set([
  1001, 1003, 1010, 1012, 1014, 1015, 1017, 1018, 1020, 1021, 1026,
]);

/**
 * Classify a response's `error_code`.
 *
 * A missing code counts as `ok`: several methods answer with no `error_code` at all on
 * success, so treating absent as failure would toast an error on every one of them.
 */
export function classifyCommandOutcome(code: number | undefined | null): CommandOutcome {
  if (code === undefined || code === null || code === 0) return 'ok';
  if (BUSY_ERROR_CODES.has(code)) return 'busy';
  if (REJECTED_ERROR_CODES.has(code)) return 'rejected';
  return 'error';
}

/** Human-readable reason for a non-zero `error_code`, falling back to the number. */
export function describeCommandError(code: number | undefined | null): string {
  if (code === undefined || code === null) return 'unknown error';
  return ERROR_CODE_NAMES[code] ?? `error ${code}`;
}

/**
 * Commands whose failure is worth a toast, and what to call them in one.
 *
 * Only *writes* are listed. A poll that comes back busy is noise — it will be re-polled
 * seconds later — whereas a button press that silently did nothing is the whole
 * complaint behind ELEG-40. Methods handled individually elsewhere (1047 delete, 1051
 * timelapse export, 2003 filament save) are deliberately absent so they keep their more
 * specific wording.
 */
export const COMMAND_METHOD_NAMES: Record<number, string> = {
  1007: 'Emergency stop',
  1020: 'Start print',
  1021: 'Pause print',
  1022: 'Stop print',
  1023: 'Resume print',
  1024: 'Load filament',
  1025: 'Unload filament',
  1026: 'Home',
  1027: 'Move',
  1028: 'Set temperature',
  1029: 'Light switch',
  1030: 'Fan control',
  1031: 'Speed mode',
  1032: 'Auto-level',
  1033: 'Vibration optimization',
  1034: 'PID calibration',
  1035: 'Self-check',
  // 1038 (HistoryDelete) is handled individually in main.ts so it can refresh the list
  // and use delete-specific wording, so it is deliberately absent here.
};

// Exception codes from the CC2 protocol
export const EXCEPTION_NAMES: Record<number, string> = {
  101: 'Bed Heat Failed',
  102: 'Bed Temp Sensor Disconnected',
  103: 'Nozzle Heat Failed',
  104: 'Nozzle Temp Sensor Disconnected',
  105: 'Nozzle Temp Sensor Shorted',
  106: 'Bed Temp Sensor Shorted',
  107: 'Toolhead Overheating Protection',
  108: 'Bed Overheating Protection',
  109: 'Filament Runout',
  205: 'Chamber Temp Sensor Disconnected',
  206: 'Chamber Temp Sensor Shorted',
  304: 'Z Homing Failed',
  401: 'Accelerometer Chip Error',
  605: 'Pressure Sensor Data Error',
  701: 'Mainboard Fan Error',
  702: 'Heatbreak Fan Error',
  703: 'Model Fan Error',
  704: 'Leveling Failed',
  705: 'Auxiliary Fan Error',
  706: 'Case Fan Error',
  707: 'Toolhead Cover Fan Detached',
  801: 'Mainboard-Extruder Communication Error',
  802: 'Leveling Sensor Controller Communication Error',
  803: 'Critical System Error',
  901: 'Chamber Temp Too High',
  902: 'Chamber Temp Overheating Protection',
  903: 'Mainboard Driver Unit Overheating Protection',
  904: 'USB Storage Space Not Enough',
  905: 'USB Read Exception',
  906: 'Version Update Failed',
  1101: 'Exhaust Vent Open Failed',
  1102: 'Exhaust Vent Close Failed',
  1103: 'Exhaust Grille Servo Close Failed',
  1104: 'Y Motor Driver Error',
  1105: 'Z Motor Driver Error',
  1106: 'Extruder Motor Driver Error',
  1210: 'Canvas Communication Error',
  1211: 'Canvas Filament Runout',
  1220: 'Canvas: Abnormal Filament In Extruder',
  1231: 'Canvas: Cutter Knife Not Pressed',
  1232: 'Canvas: Cutter Knife Not Released',
  1241: 'Canvas: Feed Sensor Not Triggered',
  1242: 'Canvas: Feed Self-Check Timeout',
  1243: 'Canvas: Feed Blocked (Extruder)',
  1244: 'Toolhead Extrusion Failed',
  1251: 'Canvas: Retract Failed (Filament Broken)',
  1252: 'Canvas: Retract Self-Check Timeout',
  1260: 'Canvas: Filament Runout Exception',
  1261: 'Toolhead Front Cover Detached',
  1262: 'Canvas: Cutter Exception',
  1263: 'Canvas: Filament Tangling',
  1264: 'External Filament Blockage',
  1300: 'Print File Unavailable',
  1301: 'Spaghetti Detected',
  1302: 'Print Defect Detected',
};

// Critical exceptions that typically halt the printer
export const CRITICAL_EXCEPTIONS = new Set([
  101, 102, 103, 104, 105, 106, 107, 108, 801, 803, 902, 903, 1103, 1104, 1105, 1106, 1210,
]);

// ─── Toolhead Zone Detection ───────────────────────────────────────
// CC2 bed: 256×256mm printable area, origin front-left (0,0).
// Physical head travel extends beyond 0-256 for purge/cutter operations.

export type ZoneName = 'print_area' | 'purge_area' | 'cutter_area' | 'outside';

export interface ZoneBoundary {
  name: ZoneName;
  label: string;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export interface ZoneState {
  current: ZoneName;
  previous: ZoneName;
  enteredAt: number; // timestamp when entered current zone
  history: Array<{ zone: ZoneName; entered: number; exited: number }>;
}

/** CC2 zone boundaries — checked in order, first match wins */
export const ZONE_DEFINITIONS: ZoneBoundary[] = [
  // Cutter area: front-right corner, centered ~X=254 Y=3.5
  { name: 'cutter_area', label: 'Cutter', xMin: 245, xMax: 265, yMin: -5, yMax: 15 },
  // Purge/poop area: back-left, centered ~X=52.5 Y=264
  { name: 'purge_area', label: 'Purge', xMin: 40, xMax: 65, yMin: 257, yMax: 275 },
  // Normal printable area
  { name: 'print_area', label: 'Print Area', xMin: 0, xMax: 256, yMin: 0, yMax: 256 },
];

export const ZONE_MAX_HISTORY = 50;

export function detectZone(x: number, y: number): ZoneName {
  for (const z of ZONE_DEFINITIONS) {
    if (x >= z.xMin && x <= z.xMax && y >= z.yMin && y <= z.yMax) {
      return z.name;
    }
  }
  return 'outside';
}

// ── Layer-time series ────────────────────────────────────────────────

/** One completed layer: how long it took, and when it finished. */
export interface LayerTimeEntry {
  layer: number;
  duration: number;
  timestamp: number;
}

/**
 * Keep only the trailing strictly-increasing run of a layer-time series.
 *
 * The series is supposed to be monotonic in `layer` within a print, and since ELEG-16 the
 * store no longer produces one that is not. But a series can still arrive non-monotonic
 * from *outside* that guarantee — `data/state.json` written before that fix, or any
 * future path that gets it wrong — and a cross-print entry then skews `/api/metrics`, the
 * MCP `layers` tool and the print-report stats, none of which look at anything but the
 * raw array (ELEG-18).
 *
 * Anything at or before the last decrease belongs to a previous print, so it goes. Its
 * duration spans the gap *between* two prints, which is why leaving it in is worse than
 * dropping it: on the live repro one 155s phantom sat among 14s layers.
 *
 * Lives in `types.ts` because both halves need the identical rule — the server sanitising
 * at the restore boundary, the chart choosing what to plot — and two copies would be free
 * to disagree. Pure, and covered by `src/__tests__/layer-chart.test.ts`.
 */
export function trailingLayerRun<T extends LayerTimeEntry>(entries: readonly T[]): T[] {
  let start = 0;
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].layer <= entries[i - 1].layer) start = i;
  }
  return entries.slice(start);
}
