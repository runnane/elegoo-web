import type { PrinterState } from '../printer-state';
import type { CommandSender } from '../ws-client';
import {
  STATUS_NAMES,
  SUB_STATUS_NAMES,
  EXCEPTION_NAMES,
  CRITICAL_EXCEPTIONS,
  powerLossState,
} from '../types';
import { maybeShowPowerLossDialog } from './power-loss-dialog';
import { $, formatTime, formatClock, fanPct, escapeHtml, applyDarkThumbnailCheck } from './helpers';
import { loadUISettings, saveUISettings } from './ui-settings';

let lastThumbnailFile = '';

// Filament densities (g/cm³) for length calculation
const FILAMENT_DENSITY: Record<string, number> = {
  PLA: 1.24,
  ABS: 1.04,
  ASA: 1.07,
  PETG: 1.27,
  TPU: 1.21,
  PA: 1.14,
  PC: 1.2,
  PVA: 1.23,
  HIPS: 1.04,
};
const FILAMENT_DIAMETER_CM = 0.175; // 1.75mm
const CROSS_SECTION_CM2 = Math.PI * (FILAMENT_DIAMETER_CM / 2) ** 2;

// Extrusion tracking for live flow rate
const FILAMENT_RADIUS_MM = 1.75 / 2;
const CROSS_SECTION_MM2 = Math.PI * FILAMENT_RADIUS_MM * FILAMENT_RADIUS_MM;
let _prevE = 0;
let _prevETime = 0;
let _lastExtRate = 0;
let _lastFlowRate = 0;
let _lastMassFlow = 0;
let _lastPulseTime = 0;

function gramsToMeters(grams: number, filamentType: string): number {
  const density = FILAMENT_DENSITY[filamentType.toUpperCase()] ?? FILAMENT_DENSITY.PLA;
  const volumeCm3 = grams / density;
  return volumeCm3 / CROSS_SECTION_CM2 / 100;
}

function getActiveFilamentType(state: PrinterState): string {
  // Try active Canvas tray
  const canvas = state.canvas;
  if (canvas?.canvas_list?.length) {
    for (const unit of canvas.canvas_list) {
      if (unit.canvas_id !== canvas.active_canvas_id) continue;
      for (const tray of unit.tray_list) {
        if (tray.tray_id === canvas.active_tray_id && tray.filament_type) {
          return tray.filament_type;
        }
      }
    }
  }
  // Try mono filament
  const mono = state.monoFilament as Record<string, unknown> | null;
  if (mono?.filament_type) return mono.filament_type as string;
  return 'PLA';
}

/** Get active filament type + color for display */
function getActiveFilamentInfo(state: PrinterState): { type: string; color: string } | null {
  const canvas = state.canvas;
  if (canvas?.canvas_list?.length) {
    for (const unit of canvas.canvas_list) {
      if (unit.canvas_id !== canvas.active_canvas_id) continue;
      for (const tray of unit.tray_list) {
        if (tray.tray_id === canvas.active_tray_id && tray.filament_type) {
          const color = `#${(tray.filament_color || '434343').replace(/^#/, '')}`;
          return { type: tray.filament_type, color };
        }
      }
    }
  }
  const mono = state.monoFilament as Record<string, unknown> | null;
  if (mono?.filament_type) {
    const color = `#${((mono.filament_color as string) || '434343').replace(/^#/, '')}`;
    return { type: mono.filament_type as string, color };
  }
  return null;
}

function updateFan(prefix: string, speed: number, toggleId: string, rpm?: number): void {
  const pct = fanPct(speed);
  ($(`${prefix}-bar`) as HTMLElement).style.width = `${pct}%`;
  $(`${prefix}-value`).textContent = `${pct}%`;
  ($(toggleId) as HTMLInputElement).checked = speed > 0;
  const rpmEl = $(`${prefix}-rpm`);
  if (rpmEl) {
    rpmEl.textContent = rpm != null && rpm > 0 ? `${rpm} RPM` : '';
  }
}

let overlayEnabled = loadUISettings().cameraOverlay;

function getCameraStreamUrl(): string {
  return overlayEnabled ? '/api/stream/overlay' : '/api/stream';
}

export function toggleCameraOverlay(): void {
  overlayEnabled = !overlayEnabled;
  saveUISettings({ cameraOverlay: overlayEnabled });
  const img = $('camera-feed') as HTMLImageElement;
  const btn = $('camera-overlay-btn');
  if (img && !img.classList.contains('hidden')) {
    img.src = getCameraStreamUrl();
  }
  // Also update modal img if visible
  const modalImg = $('camera-modal-img') as HTMLImageElement;
  if (modalImg && modalImg.src) {
    modalImg.src = getCameraStreamUrl();
  }
  if (btn) {
    btn.classList.toggle('active', overlayEnabled);
    btn.textContent = overlayEnabled ? '📊 Overlay ✓' : '📊 Overlay';
  }
}

function updateCamera(hasCamera: boolean, _printerIp: string): void {
  const img = $('camera-feed') as HTMLImageElement;
  const overlay = $('camera-overlay');

  if (hasCamera) {
    const src = getCameraStreamUrl();
    if (!img.src.endsWith(new URL(src, location.href).pathname)) {
      img.src = src;
    }
    overlay.classList.add('hidden');
    img.classList.remove('hidden');
  } else {
    img.classList.add('hidden');
    overlay.classList.remove('hidden');
    overlay.textContent = 'Camera not connected';
  }
}

export function renderDashboard(state: PrinterState, client: CommandSender): void {
  const s = state.status;
  if (!s) return;

  const machineStatus = s.machine_status;
  const ps = s.print_status;
  const isPrinting = machineStatus?.status === 2;
  const isPaused = machineStatus?.sub_status === 2502 || machineStatus?.sub_status === 2505;
  const statusName = STATUS_NAMES[machineStatus?.status] ?? 'Unknown';
  const subStatusName = SUB_STATUS_NAMES[machineStatus?.sub_status] ?? '';
  const powerLoss = powerLossState(machineStatus?.status, machineStatus?.sub_status);

  // A half-finished print is waiting on a human, and this is the thing they have open.
  maybeShowPowerLossDialog(powerLoss, ps?.filename, client);

  // Thumbnail — request once per file, don't retry on failure
  if (ps?.filename && ps.filename !== lastThumbnailFile) {
    lastThumbnailFile = ps.filename;
    state.thumbnail = null;
    state.thumbnailFailed = false;
    state.fileFilamentUsed = null;
    state.thumbnailRequestQueue.push('print');
    client.sendCommand(1045, { storage_media: 'local', file_name: ps.filename });
    client.sendCommand(1046, { storage_media: 'local', filename: ps.filename });
  }

  // Show thumbnail
  const thumbImg = $('print-thumbnail') as HTMLImageElement;
  const thumbPlaceholder = $('print-thumbnail-placeholder');
  if (state.thumbnail) {
    thumbImg.src = `data:image/png;base64,${state.thumbnail}`;
    thumbImg.classList.remove('hidden');
    thumbPlaceholder.classList.add('hidden');
    applyDarkThumbnailCheck(thumbImg, $('print-thumbnail-wrap'));
  } else {
    thumbImg.classList.add('hidden');
    thumbPlaceholder.classList.remove('hidden');
    thumbPlaceholder.textContent = state.thumbnailFailed ? 'No preview' : '🖨️';
    $('print-thumbnail-wrap').classList.remove('thumbnail-dark');
  }

  // Print filename
  if (ps?.filename) {
    $('print-filename').textContent = ps.filename;
    $('print-filename').title = ps.filename;
  } else {
    $('print-filename').textContent = statusName + (subStatusName ? ` — ${subStatusName}` : '');
  }

  // Status badge — always show both status and sub-status
  const badge = $('print-status-badge');
  const subLabel = subStatusName ? ` · ${subStatusName}` : '';
  if (isPrinting && !isPaused) {
    badge.textContent = `⟳ Printing${subLabel}`;
    badge.className = 'print-status-badge badge-printing';
  } else if (isPaused) {
    badge.textContent = `⏸ Paused${subLabel}`;
    badge.className = 'print-status-badge badge-paused';
  } else if (machineStatus?.status === 5) {
    badge.textContent = `📐 ${statusName}${subLabel}`;
    badge.className = 'print-status-badge badge-busy';
  } else if (
    machineStatus?.status === 3 ||
    machineStatus?.status === 4 ||
    machineStatus?.status === 13
  ) {
    badge.textContent = `🔄 ${statusName}${subLabel}`;
    badge.className = 'print-status-badge badge-busy';
  } else if (
    machineStatus?.status === 6 ||
    machineStatus?.status === 7 ||
    machineStatus?.status === 8
  ) {
    badge.textContent = `⚙️ ${statusName}${subLabel}`;
    badge.className = 'print-status-badge badge-busy';
  } else if (machineStatus?.status === 14) {
    badge.textContent = `🛑 ${statusName}`;
    badge.className = 'print-status-badge badge-error';
  } else if (powerLoss !== 'none') {
    // Status 15 used to fall through to the `else` below and render as `badge-idle` —
    // the printer sitting on a half-finished job awaiting a decision, styled as though
    // it had nothing to do (ELEG-29).
    badge.textContent =
      powerLoss === 'awaiting_decision'
        ? '⚡ Power loss — resume or cancel'
        : `⚡ ${statusName}${subLabel}`;
    badge.className =
      'print-status-badge ' + (powerLoss === 'awaiting_decision' ? 'badge-error' : 'badge-busy');
  } else {
    badge.textContent = statusName + subLabel;
    badge.className = 'print-status-badge badge-idle';
  }

  // Progress — compute from durations in delta updates (available every second)
  // machine_status.progress only arrives from full 1002 responses (every ~5s)
  let progress = machineStatus?.progress ?? 0;
  if ((isPrinting || isPaused) && ps?.print_duration != null && ps?.remaining_time_sec != null) {
    const total = ps.print_duration + ps.remaining_time_sec;
    if (total > 0) {
      progress = Math.min(99, Math.round((ps.print_duration / total) * 100));
    }
  }
  const progressText = $('print-progress-text');
  progressText.textContent = isPrinting || isPaused ? `${progress}%` : '';
  const progressBar = $('print-progress-bar') as HTMLElement;
  progressBar.style.width = `${progress}%`;
  progressBar.classList.toggle('active', isPrinting && !isPaused);
  // Pulse progress text every ~2s while printing to show data is live
  const pulseNow = Date.now();
  if ((isPrinting || isPaused) && pulseNow - _lastPulseTime >= 2000) {
    _lastPulseTime = pulseNow;
    progressText.classList.remove('pulse');
    void progressText.offsetWidth;
    progressText.classList.add('pulse');
  } else if (!isPrinting && !isPaused) {
    progressText.classList.remove('pulse');
  }

  // Window title — show status and progress
  if (isPrinting || isPaused) {
    const pctStr = `${progress}%`;
    const stateStr = isPaused ? 'Paused' : 'Printing';
    const sub = subStatusName ? ` · ${subStatusName}` : '';
    document.title = `${pctStr} ${stateStr}${sub} — elegoo-web`;
  } else if (machineStatus?.status === 1) {
    document.title = 'Idle — elegoo-web';
  } else {
    const sub = subStatusName ? ` · ${subStatusName}` : '';
    document.title = `${statusName}${sub} — elegoo-web`;
  }

  // Layer info — use fileTotalLayers from method 1046 or fallback to print_status
  const totalLayer = ps?.total_layer ?? state.fileTotalLayers ?? '??';
  const currentLayer = ps?.current_layer ?? '--';
  $('print-layer').textContent = `Layer: ${currentLayer}/${totalLayer}`;

  // Filament usage from method 1046
  const filamentUsed = state.fileFilamentUsed;
  if (filamentUsed != null && (isPrinting || isPaused)) {
    const lengthM = gramsToMeters(filamentUsed, getActiveFilamentType(state));
    $('print-filament').textContent = `🧵 ${filamentUsed.toFixed(1)}g (${lengthM.toFixed(1)}m)`;
  } else {
    $('print-filament').textContent = '--';
  }

  // Active filament display
  const activeFilamentEl = $('print-active-filament');
  const colorChangesEl = $('print-color-changes');
  if (isPrinting || isPaused) {
    const activeInfo = getActiveFilamentInfo(state);
    if (activeInfo) {
      activeFilamentEl.innerHTML = `<span class="filament-swatch" style="background:${escapeHtml(activeInfo.color)}"></span> ${escapeHtml(activeInfo.type)}`;
    } else {
      activeFilamentEl.textContent = `🧵 ${getActiveFilamentType(state)}`;
    }
    // Color changes from color_map
    const colorMap = state.colorMap;
    if (colorMap.length > 1) {
      colorChangesEl.textContent = `🔄 ${colorMap.length} filaments`;
    } else {
      colorChangesEl.textContent = '';
    }
  } else {
    activeFilamentEl.textContent = '--';
    colorChangesEl.textContent = '';
  }

  // Remaining time
  const remaining = formatTime(ps?.remaining_time_sec);
  $('print-remaining').textContent =
    (isPrinting || isPaused) && remaining !== '--' ? `Remaining: ${remaining}` : '--';

  // Elapsed time
  const printDur = ps?.print_duration;
  if (printDur != null && (isPrinting || isPaused)) {
    $('print-elapsed').textContent = `Elapsed: ${formatTime(printDur)}`;
  } else {
    $('print-elapsed').textContent = '--';
  }

  // Start time and ETA (calculated from elapsed / remaining)
  if ((isPrinting || isPaused) && printDur != null) {
    const startedAt = new Date(Date.now() - printDur * 1000);
    $('print-started').textContent = `Started: ${formatClock(startedAt)}`;
  } else {
    $('print-started').textContent = '--';
  }
  if ((isPrinting || isPaused) && ps?.remaining_time_sec != null && ps.remaining_time_sec > 0) {
    const eta = new Date(Date.now() + ps.remaining_time_sec * 1000);
    $('print-eta').textContent = `ETA: ${formatClock(eta)}`;
  } else {
    $('print-eta').textContent = '--';
  }

  // Print action buttons
  $('btn-pause').classList.toggle('hidden', !isPrinting || isPaused);
  $('btn-resume').classList.toggle('hidden', !isPaused);
  $('btn-stop').classList.toggle('hidden', !isPrinting && !isPaused);

  // Temperatures (show 2 decimal places like Elegoo app)
  const ext = s.extruder;
  if (ext) {
    $('temp-nozzle').textContent = ext.temperature.toFixed(2);
    $('temp-nozzle-target').textContent = Math.round(ext.target).toString();
    const nozzlePct = ext.target > 0 ? Math.min(100, (ext.temperature / ext.target) * 100) : 0;
    ($('temp-nozzle-bar') as HTMLElement).style.width = `${nozzlePct}%`;
    const nozzleBar = $('temp-nozzle-bar') as HTMLElement;
    nozzleBar.classList.toggle('heating', ext.temperature < ext.target - 2 && ext.target > 0);
    nozzleBar.classList.toggle(
      'at-target',
      Math.abs(ext.temperature - ext.target) <= 2 && ext.target > 0,
    );
  }

  const bed = s.heater_bed;
  if (bed) {
    $('temp-bed').textContent = bed.temperature.toFixed(2);
    $('temp-bed-target').textContent = Math.round(bed.target).toString();
    const bedPct = bed.target > 0 ? Math.min(100, (bed.temperature / bed.target) * 100) : 0;
    ($('temp-bed-bar') as HTMLElement).style.width = `${bedPct}%`;
    const bedBar = $('temp-bed-bar') as HTMLElement;
    bedBar.classList.toggle('heating', bed.temperature < bed.target - 2 && bed.target > 0);
    bedBar.classList.toggle(
      'at-target',
      Math.abs(bed.temperature - bed.target) <= 2 && bed.target > 0,
    );
  }

  const chamber = s.ztemperature_sensor;
  if (chamber) {
    $('temp-chamber').textContent = chamber.temperature.toFixed(2);
    const minT = chamber.measured_min_temperature;
    const maxT = chamber.measured_max_temperature;
    const rangeEl = $('temp-chamber-range');
    if (minT != null && maxT != null && (minT > 0 || maxT > 0)) {
      rangeEl.textContent = `(↓${minT.toFixed(0)} ↑${maxT.toFixed(0)})`;
    } else {
      rangeEl.textContent = '';
    }
  }

  // Position
  const pos = s.gcode_move;
  if (pos) {
    $('pos-x').textContent = pos.x?.toFixed(1) ?? '--';
    $('pos-y').textContent = pos.y?.toFixed(1) ?? '--';
    $('pos-z').textContent = pos.z?.toFixed(1) ?? '--';
  }

  // Homing status
  const homed = s.tool_head?.homed_axes ?? '';
  for (const a of ['x', 'y', 'z'] as const) {
    const dot = $(`home-${a}`);
    const isHomed = homed.includes(a);
    dot.classList.toggle('homed', isHomed);
    dot.title = isHomed ? `${a.toUpperCase()} homed` : `${a.toUpperCase()} not homed`;
  }

  // Live speed & flow
  $('live-speed').textContent = pos?.speed ? `${Math.round(pos.speed)} mm/min` : '-- mm/min';
  const currentE = pos?.extruder ?? pos?.e ?? 0;
  const now = Date.now();
  // Only recompute rates when we get a NEW extruder position (not every render)
  if (currentE !== _prevE && _prevETime > 0) {
    const dt = (now - _prevETime) / 1000;
    if (dt > 0 && currentE > _prevE) {
      _lastExtRate = (currentE - _prevE) / dt;
      _lastFlowRate = _lastExtRate * CROSS_SECTION_MM2;
      const activeType = getActiveFilamentType(state);
      const density = FILAMENT_DENSITY[activeType.toUpperCase()] ?? FILAMENT_DENSITY.PLA;
      _lastMassFlow = (_lastExtRate / 10) * CROSS_SECTION_CM2 * density * 1000; // mg/s
    }
    _prevE = currentE;
    _prevETime = now;
  } else if (_prevETime === 0 && currentE > 0) {
    // First sample — just record baseline
    _prevE = currentE;
    _prevETime = now;
  }
  $('live-extrusion').textContent =
    _lastExtRate > 0 ? `${_lastExtRate.toFixed(1)} mm/s` : '-- mm/s';
  $('live-flow').textContent = _lastFlowRate > 0 ? `${_lastFlowRate.toFixed(1)} mm³/s` : '-- mm³/s';
  $('live-mass-flow').textContent =
    _lastMassFlow > 0 ? `${_lastMassFlow.toFixed(1)} mg/s` : '-- mg/s';

  // Per-spool filament usage
  renderFilamentUsage(state);

  // Fans — use Elegoo naming (Model/Assistance/Case)
  const fans = s.fans;
  if (fans) {
    updateFan('fan-model', fans.fan?.speed ?? 0, 'fan-model-toggle', fans.fan?.rpm);
    updateFan('fan-aux', fans.aux_fan?.speed ?? 0, 'fan-aux-toggle', fans.aux_fan?.rpm);
    updateFan('fan-case', fans.box_fan?.speed ?? 0, 'fan-case-toggle', fans.box_fan?.rpm);
  }

  // Speed mode buttons — status reports 0/1/2/3, buttons use command values 50/100/130/160
  const speedModeMap: Record<number, number> = { 0: 50, 1: 100, 2: 130, 3: 160 };
  const speedMode = speedModeMap[pos?.speed_mode ?? 1] ?? 100;
  document.querySelectorAll('.speed-btn').forEach((btn) => {
    const mode = parseInt((btn as HTMLElement).dataset.mode ?? '100');
    btn.classList.toggle('active', mode === speedMode);
  });

  // LED toggle
  const ledOn = s.led?.status === 1;
  ($('led-toggle') as HTMLInputElement).checked = ledOn;

  // Camera
  updateCamera(s.external_device?.camera ?? false, client.printerIp);

  // Exception banner
  renderExceptions(machineStatus?.exception_status ?? []);
}

export function renderHeader(state: PrinterState): void {
  const attrs = state.attributes;
  if (attrs) {
    $('printer-name').textContent =
      `${attrs.hostname} (${attrs.machine_model}) — FW ${attrs.software_version?.ota_version}`;
  }
}

let lastExceptionKey = '';

function renderExceptions(codes: number[]): void {
  const banner = $('exception-banner');
  if (!codes.length) {
    banner.classList.add('hidden');
    banner.innerHTML = '';
    lastExceptionKey = '';
    return;
  }

  const key = codes.join(',');
  if (key === lastExceptionKey) return;
  lastExceptionKey = key;

  const items = codes.map((code) => {
    const name = EXCEPTION_NAMES[code] ?? `Unknown Error (${code})`;
    const isCritical = CRITICAL_EXCEPTIONS.has(code);
    const cls = isCritical ? 'exception-item critical' : 'exception-item warning';
    const icon = isCritical ? '🔴' : '🟡';
    return `<div class="${cls}">${icon} <strong>${escapeHtml(String(code))}</strong> — ${escapeHtml(name)}</div>`;
  });

  banner.innerHTML = items.join('');
  banner.classList.remove('hidden');
}

/** Render per-spool filament usage summary */
function renderFilamentUsage(state: PrinterState): void {
  const container = document.getElementById('filament-usage-display');
  if (!container) return;
  const usage = state.filamentUsage;
  if (!usage || usage.length === 0) {
    container.innerHTML = '';
    return;
  }
  const totalGrams = usage.reduce((sum, u) => sum + u.grams, 0);
  const totalMeters = usage.reduce((sum, u) => sum + u.meters, 0);
  let html = '<div class="filament-usage-header">Filament Used</div>';
  for (const u of usage) {
    const label = u.trayKey === 'mono' ? u.filamentType : `${u.filamentType}`;
    html += `<div class="filament-usage-row">
      <span class="filament-usage-swatch" style="background:${escapeHtml(u.color)}"></span>
      <span class="filament-usage-label">${escapeHtml(label)}</span>
      <span class="filament-usage-val">${u.meters.toFixed(3)} m</span>
      <span class="filament-usage-val">${u.grams.toFixed(3)} g</span>
    </div>`;
  }
  if (usage.length > 1) {
    html += `<div class="filament-usage-row filament-usage-total">
      <span class="filament-usage-swatch"></span>
      <span class="filament-usage-label">Total</span>
      <span class="filament-usage-val">${totalMeters.toFixed(3)} m</span>
      <span class="filament-usage-val">${totalGrams.toFixed(3)} g</span>
    </div>`;
  }
  container.innerHTML = html;
}
