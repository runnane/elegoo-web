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
  name: string;
  size: number;
  modified?: number;
  type?: string;
}

// Machine status codes
export const STATUS_NAMES: Record<number, string> = {
  0: 'Initializing',
  1: 'Idle',
  2: 'Printing',
  3: 'Loading Filament',
  4: 'Loading Filament',
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

export const SUB_STATUS_NAMES: Record<number, string> = {
  0: '',
  1045: 'Preheating Nozzle',
  1096: 'Preheating Nozzle',
  1405: 'Preheating Bed',
  1906: 'Preheating Bed',
  2075: 'Printing',
  2077: 'Completed',
  2401: 'Resuming',
  2402: 'Resume Complete',
  2501: 'Pausing',
  2502: 'Paused',
  2505: 'Paused',
  2503: 'Stopping',
  2504: 'Stopped',
  2801: 'Homing',
  2802: 'Homing Done',
  2901: 'Auto Leveling',
  2902: 'Leveling Done',
};

export const SPEED_MODE_NAMES: Record<number, string> = {
  0: 'Silent',
  1: 'Balanced',
  2: 'Sport',
  3: 'Ludicrous',
};
