import type { PrinterState } from '../printer-state';
import type { CC2MqttClient } from '../mqtt-client';
import { STATUS_NAMES, SUB_STATUS_NAMES, SPEED_MODE_NAMES } from '../types';

function formatTime(seconds: number): string {
  if (!seconds || seconds < 0) return '--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fanPct(speed: number): number {
  return Math.round((speed / 255) * 100);
}

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

export function renderDashboard(state: PrinterState, client: CC2MqttClient): void {
  const s = state.status;
  if (!s) return;

  // Print status bar
  const machineStatus = s.machine_status;
  const ps = s.print_status;
  const isPrinting = machineStatus?.status === 2;
  const isPaused = machineStatus?.sub_status === 2502 || machineStatus?.sub_status === 2505;
  const statusName = STATUS_NAMES[machineStatus?.status] ?? 'Unknown';
  const subStatusName = SUB_STATUS_NAMES[machineStatus?.sub_status] ?? '';

  // Print filename and status
  if (ps?.filename) {
    $('print-filename').textContent = ps.filename;
    $('print-filename').title = ps.filename;
  } else {
    $('print-filename').textContent = statusName + (subStatusName ? ` — ${subStatusName}` : '');
  }

  // Progress
  const progress = machineStatus?.progress ?? 0;
  $('print-progress-text').textContent = isPrinting ? `${progress}%` : statusName;
  ($('print-progress-bar') as HTMLElement).style.width = `${progress}%`;

  // Layer info
  if (ps?.current_layer != null) {
    const totalLayer = ps.total_layer ?? '??';
    $('print-layer').textContent = `Layer: ${ps.current_layer}/${totalLayer}`;
  }

  // Time
  $('print-elapsed').textContent = `Elapsed: ${formatTime(ps?.print_duration)}`;
  $('print-remaining').textContent = `Remaining: ${formatTime(ps?.remaining_time_sec)}`;

  // Print action buttons
  $('btn-pause').classList.toggle('hidden', !isPrinting || isPaused);
  $('btn-resume').classList.toggle('hidden', !isPaused);
  $('btn-stop').classList.toggle('hidden', !isPrinting && !isPaused);

  // Temperatures
  const ext = s.extruder;
  if (ext) {
    $('temp-nozzle').textContent = Math.round(ext.temperature).toString();
    $('temp-nozzle-target').textContent = Math.round(ext.target).toString();
    const nozzlePct = ext.target > 0 ? Math.min(100, (ext.temperature / ext.target) * 100) : 0;
    ($('temp-nozzle-bar') as HTMLElement).style.width = `${nozzlePct}%`;
    // Set color based on state
    const nozzleBar = $('temp-nozzle-bar') as HTMLElement;
    nozzleBar.classList.toggle('heating', ext.temperature < ext.target - 2 && ext.target > 0);
    nozzleBar.classList.toggle('at-target', Math.abs(ext.temperature - ext.target) <= 2 && ext.target > 0);
  }

  const bed = s.heater_bed;
  if (bed) {
    $('temp-bed').textContent = Math.round(bed.temperature).toString();
    $('temp-bed-target').textContent = Math.round(bed.target).toString();
    const bedPct = bed.target > 0 ? Math.min(100, (bed.temperature / bed.target) * 100) : 0;
    ($('temp-bed-bar') as HTMLElement).style.width = `${bedPct}%`;
    const bedBar = $('temp-bed-bar') as HTMLElement;
    bedBar.classList.toggle('heating', bed.temperature < bed.target - 2 && bed.target > 0);
    bedBar.classList.toggle('at-target', Math.abs(bed.temperature - bed.target) <= 2 && bed.target > 0);
  }

  const chamber = s.ztemperature_sensor;
  if (chamber) {
    $('temp-chamber').textContent = Math.round(chamber.temperature).toString();
  }

  // Position
  const pos = s.gcode_move;
  if (pos) {
    $('pos-x').textContent = pos.x?.toFixed(1) ?? '--';
    $('pos-y').textContent = pos.y?.toFixed(1) ?? '--';
    $('pos-z').textContent = pos.z?.toFixed(2) ?? '--';
  }

  // Fans
  const fans = s.fans;
  if (fans) {
    updateFan('fan-part', fans.fan?.speed ?? 0);
    updateFan('fan-aux', fans.aux_fan?.speed ?? 0);
    updateFan('fan-box', fans.box_fan?.speed ?? 0);
  }

  // Speed mode buttons
  const speedMode = pos?.speed_mode ?? 1;
  document.querySelectorAll('.speed-btn').forEach(btn => {
    const mode = parseInt((btn as HTMLElement).dataset.mode ?? '1');
    btn.classList.toggle('active', mode === speedMode);
  });

  // LED
  const ledOn = s.led?.status === 1;
  $('btn-led-toggle').textContent = ledOn ? '💡 On' : '🌑 Off';

  // Camera
  updateCamera(s.external_device?.camera ?? false, client.printerIp);
}

function updateFan(prefix: string, speed: number): void {
  const pct = fanPct(speed);
  ($(`${prefix}-bar`) as HTMLElement).style.width = `${pct}%`;
  $(`${prefix}-value`).textContent = `${pct}%`;
}

function updateCamera(hasCamera: boolean, printerIp: string): void {
  const img = $('camera-feed') as HTMLImageElement;
  const overlay = $('camera-overlay');

  if (hasCamera) {
    const src = `http://${printerIp}:8080/?action=stream`;
    if (img.src !== src) {
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

export function renderCanvas(state: PrinterState): void {
  const container = $('canvas-status');
  const canvas = state.canvas;

  if (!canvas || !canvas.canvas_list?.length) {
    container.innerHTML = '<div class="canvas-empty">No Canvas/AMS detected</div>';
    return;
  }

  let html = '';
  for (const unit of canvas.canvas_list) {
    html += `<div class="canvas-unit">`;
    html += `<div class="canvas-unit-header">Canvas ${unit.canvas_id + 1} ${unit.connected ? '🟢' : '🔴'}</div>`;
    html += `<div class="tray-list">`;

    for (const tray of unit.tray_list) {
      const isActive = unit.canvas_id === canvas.active_canvas_id &&
        tray.tray_id === canvas.active_tray_id;
      const statusClass = tray.status === 2 ? 'active' : tray.status === 1 ? 'loaded' : 'empty';

      html += `
        <div class="tray-slot ${statusClass} ${isActive ? 'current' : ''}">
          <div class="tray-color" style="background-color: ${escapeAttr(tray.filament_color)}"></div>
          <div class="tray-info">
            <div class="tray-name">A${tray.tray_id + 1}</div>
            <div class="tray-filament">${escapeHtml(tray.filament_type)}</div>
            <div class="tray-brand">${escapeHtml(tray.filament_name)}</div>
          </div>
          <div class="tray-temp">${tray.min_nozzle_temp}-${tray.max_nozzle_temp}°C</div>
        </div>`;
    }

    html += `</div></div>`;
  }

  html += `<div class="canvas-meta">`;
  html += `Auto-refill: ${canvas.auto_refill ? 'On' : 'Off'}`;
  html += `</div>`;

  container.innerHTML = html;
}

export function renderFiles(state: PrinterState, client: CC2MqttClient): void {
  const container = $('file-list');
  const files = state.files;

  if (!files.length) {
    container.innerHTML = '<div class="file-empty">No files on printer</div>';
    return;
  }

  let html = '';
  for (const file of files) {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
    html += `
      <div class="file-item" data-filename="${escapeAttr(file.name)}">
        <div class="file-icon">📄</div>
        <div class="file-details">
          <div class="file-name">${escapeHtml(file.name)}</div>
          <div class="file-size">${sizeMB} MB</div>
        </div>
        <button class="btn btn-sm btn-primary file-print-btn">Print</button>
      </div>`;
  }

  container.innerHTML = html;

  // Attach print handlers
  container.querySelectorAll('.file-print-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest('.file-item') as HTMLElement;
      const filename = item?.dataset.filename;
      if (filename && confirm(`Start printing ${filename}?`)) {
        client.sendCommand(1020, {
          storage_media: 'local',
          filename,
          config: {
            delay_video: false,
            printer_check: true,
            print_layout: 'A',
            bedlevel_force: false,
            slot_map: [],
          },
        });
      }
    });
  });
}

function escapeHtml(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Set up printer name in header */
export function renderHeader(state: PrinterState): void {
  const attrs = state.attributes;
  if (attrs) {
    $('printer-name').textContent = `${attrs.hostname} (${attrs.machine_model}) — FW ${attrs.software_version?.ota_version}`;
  }
}

/** Bind all control event handlers */
export function bindControls(client: CC2MqttClient): void {
  // Print controls
  $('btn-pause').addEventListener('click', () => client.sendCommand(1021, {}));
  $('btn-resume').addEventListener('click', () => client.sendCommand(1023, {}));
  $('btn-stop').addEventListener('click', () => {
    if (confirm('Stop the current print?')) {
      client.sendCommand(1022, {});
    }
  });

  // Temperature controls
  $('btn-set-nozzle').addEventListener('click', () => {
    const val = parseInt(($('set-nozzle-temp') as HTMLInputElement).value);
    if (val >= 0 && val <= 300) {
      client.sendCommand(1028, { extruder: val });
    }
  });
  $('btn-off-nozzle').addEventListener('click', () => {
    client.sendCommand(1028, { extruder: 0 });
  });
  $('btn-set-bed').addEventListener('click', () => {
    const val = parseInt(($('set-bed-temp') as HTMLInputElement).value);
    if (val >= 0 && val <= 120) {
      client.sendCommand(1028, { heater_bed: val });
    }
  });
  $('btn-off-bed').addEventListener('click', () => {
    client.sendCommand(1028, { heater_bed: 0 });
  });

  // Move buttons
  document.querySelectorAll('.move-btn:not(#btn-home)').forEach(btn => {
    btn.addEventListener('click', () => {
      const el = btn as HTMLElement;
      const axis = el.dataset.axis;
      const dir = parseInt(el.dataset.dir ?? '1');
      const dist = parseFloat(($('move-distance') as HTMLSelectElement).value);
      if (axis) {
        client.sendCommand(1027, { axes: axis, distance: dist * dir });
      }
    });
  });
  $('btn-home').addEventListener('click', () => {
    client.sendCommand(1026, { homed_axes: 'xyz' });
  });

  // Speed mode
  document.querySelectorAll('.speed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = parseInt((btn as HTMLElement).dataset.mode ?? '1');
      client.sendCommand(1031, { mode });
    });
  });

  // LED toggle
  $('btn-led-toggle').addEventListener('click', () => {
    // Toggle: read current state from DOM text
    const isOn = $('btn-led-toggle').textContent?.includes('On');
    client.sendCommand(1029, { power: isOn ? 0 : 1 });
  });
}
