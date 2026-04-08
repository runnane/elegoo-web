import type { CommandSender } from '../ws-client';
import { $, fetchTimeout } from './helpers';

let controlsBound = false;

/** Track in-flight commands by unique ID → method + elements to re-enable */
let nextCmdId = 0;
const inFlight = new Map<number, { method: number; elements: HTMLElement[]; timer: ReturnType<typeof setTimeout> }>();

/** Per-method throttle: timestamp of last command sent */
const THROTTLE_MS = 100;
const lastSentAt = new Map<number, number>();

/** Called when a command response is received — re-enables all guarded buttons for that method */
export function onCommandResponse(method: number): void {
  for (const [id, entry] of inFlight) {
    if (entry.method !== method) continue;
    clearTimeout(entry.timer);
    for (const el of entry.elements) {
      (el as HTMLButtonElement).disabled = false;
      el.classList.remove('cmd-pending');
    }
    inFlight.delete(id);
  }
}

/** Send a command and disable the triggering element(s) until response or timeout */
function guardedSend(
  client: CommandSender,
  method: number,
  params: Record<string, unknown>,
  ...elements: HTMLElement[]
): void {
  // Per-method throttle: drop if sent too recently
  const now = Date.now();
  if (now - (lastSentAt.get(method) ?? 0) < THROTTLE_MS) return;
  lastSentAt.set(method, now);

  // Disable elements
  for (const el of elements) {
    (el as HTMLButtonElement).disabled = true;
    el.classList.add('cmd-pending');
  }

  client.sendCommand(method, params);

  // Per-method timeouts (official app values)
  const timeouts: Record<number, number> = {
    1024: 300_000, // Feed — 5 min
    1025: 300_000, // Retreat — 5 min
    1026: 50_000,  // Home — 50s
    1027: 25_000,  // Move — 25s
    1032: 300_000, // AutoLevel — 5 min
    1033: 300_000, // VibrationOptimize — 5 min
    1034: 300_000, // PID — 5 min
    1035: 7_200_000, // SelfCheck — 2h
  };
  const timeout = timeouts[method] ?? 10_000;

  const cmdId = nextCmdId++;
  const timer = setTimeout(() => {
    const entry = inFlight.get(cmdId);
    if (!entry) return;
    for (const el of entry.elements) {
      (el as HTMLButtonElement).disabled = false;
      el.classList.remove('cmd-pending');
    }
    inFlight.delete(cmdId);
  }, timeout);

  inFlight.set(cmdId, { method, elements, timer });
}

/** Bind all control event handlers */
export function bindControls(client: CommandSender): void {
  if (controlsBound) return;
  controlsBound = true;
  let currentMoveDistance = 10;

  // Print controls
  const btnPause = $('btn-pause') as HTMLButtonElement;
  const btnResume = $('btn-resume') as HTMLButtonElement;
  const btnStop = $('btn-stop') as HTMLButtonElement;
  btnPause.addEventListener('click', () => guardedSend(client, 1021, {}, btnPause));
  btnResume.addEventListener('click', () => guardedSend(client, 1023, {}, btnResume));
  btnStop.addEventListener('click', () => {
    if (confirm('Stop the current print?')) {
      guardedSend(client, 1022, {}, btnStop);
    }
  });

  // Emergency Stop
  const btnEStop = $('btn-estop') as HTMLButtonElement;
  btnEStop.addEventListener('click', () => {
    if (confirm('⚠️ EMERGENCY STOP\nThis immediately halts all motion and heaters.\nContinue?')) {
      guardedSend(client, 1007, {}, btnEStop);
    }
  });

  // Temperature controls
  const btnSetNozzle = $('btn-set-nozzle') as HTMLButtonElement;
  const btnOffNozzle = $('btn-off-nozzle') as HTMLButtonElement;
  const btnSetBed = $('btn-set-bed') as HTMLButtonElement;
  const btnOffBed = $('btn-off-bed') as HTMLButtonElement;

  btnSetNozzle.addEventListener('click', () => {
    const val = parseInt(($('set-nozzle-temp') as HTMLInputElement).value);
    if (val >= 0 && val <= 300) {
      guardedSend(client, 1028, { extruder: val }, btnSetNozzle);
    }
  });
  btnOffNozzle.addEventListener('click', () => {
    guardedSend(client, 1028, { extruder: 0 }, btnOffNozzle);
  });
  btnSetBed.addEventListener('click', () => {
    const val = parseInt(($('set-bed-temp') as HTMLInputElement).value);
    if (val >= 0 && val <= 120) {
      guardedSend(client, 1028, { heater_bed: val }, btnSetBed);
    }
  });
  btnOffBed.addEventListener('click', () => {
    guardedSend(client, 1028, { heater_bed: 0 }, btnOffBed);
  });

  // Move buttons — XY pad and Z column
  document.querySelectorAll('.move-btn:not(.home-btn)').forEach(btn => {
    btn.addEventListener('click', () => {
      const el = btn as HTMLElement;
      const axis = el.dataset.axis;
      const dir = parseInt(el.dataset.dir ?? '1');
      if (axis) {
        guardedSend(client, 1027, { axes: axis, distance: currentMoveDistance * dir }, el);
      }
    });
  });

  // Separate home buttons
  const btnHomeXY = $('btn-home-xy') as HTMLButtonElement;
  const btnHomeZ = $('btn-home-z') as HTMLButtonElement;
  btnHomeXY.addEventListener('click', () => {
    guardedSend(client, 1026, { homed_axes: 'xy' }, btnHomeXY);
  });
  btnHomeZ.addEventListener('click', () => {
    guardedSend(client, 1026, { homed_axes: 'z' }, btnHomeZ);
  });

  // Distance buttons
  document.querySelectorAll('.dist-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      currentMoveDistance = parseFloat((btn as HTMLElement).dataset.dist ?? '10');
      document.querySelectorAll('.dist-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  // Speed mode
  document.querySelectorAll('.speed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = parseInt((btn as HTMLElement).dataset.mode ?? '100');
      guardedSend(client, 1031, { mode }, btn as HTMLElement);
    });
  });

  // Fan toggle controls
  $('fan-model-toggle').addEventListener('change', (e) => {
    const on = (e.target as HTMLInputElement).checked;
    guardedSend(client, 1030, { fan: on ? 255 : 0 }, e.target as HTMLElement);
  });
  $('fan-aux-toggle').addEventListener('change', (e) => {
    const on = (e.target as HTMLInputElement).checked;
    guardedSend(client, 1030, { aux_fan: on ? 255 : 0 }, e.target as HTMLElement);
  });
  $('fan-case-toggle').addEventListener('change', (e) => {
    const on = (e.target as HTMLInputElement).checked;
    guardedSend(client, 1030, { box_fan: on ? 255 : 0 }, e.target as HTMLElement);
  });

  // Fan +/- buttons
  document.querySelectorAll('.fan-dec, .fan-inc').forEach(btn => {
    btn.addEventListener('click', () => {
      const el = btn as HTMLElement;
      const fanKey = el.dataset.fan!;
      const step = parseInt(el.dataset.step ?? '13'); // ~5% of 255
      const barId = fanKey === 'fan' ? 'fan-model-bar' : fanKey === 'aux_fan' ? 'fan-aux-bar' : 'fan-case-bar';
      const bar = $(barId) as HTMLElement;
      const currentPct = parseFloat(bar.style.width) || 0;
      const currentVal = Math.round((currentPct / 100) * 255);
      const newVal = Math.max(0, Math.min(255, currentVal + step));
      guardedSend(client, 1030, { [fanKey]: newVal }, el);
    });
  });

  // LED toggle
  $('led-toggle').addEventListener('change', (e) => {
    const on = (e.target as HTMLInputElement).checked;
    guardedSend(client, 1029, { power: on ? 1 : 0 }, e.target as HTMLElement);
  });

  // Temperature presets
  document.querySelectorAll('.temp-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const el = btn as HTMLElement;
      const nozzle = parseInt(el.dataset.nozzle ?? '0');
      const bed = parseInt(el.dataset.bed ?? '0');
      guardedSend(client, 1028, { extruder: nozzle, heater_bed: bed }, el);
      ($('set-nozzle-temp') as HTMLInputElement).value = nozzle > 0 ? String(nozzle) : '';
      ($('set-bed-temp') as HTMLInputElement).value = bed > 0 ? String(bed) : '';
    });
  });

  // MQTT debug capture
  const captureBtn = $('btn-mqtt-capture') as HTMLButtonElement;
  captureBtn.addEventListener('click', async () => {
    if (captureBtn.disabled) return;
    const duration = 10;
    captureBtn.disabled = true;
    captureBtn.textContent = `⏳ ${duration}s...`;
    try {
      const res = await fetchTimeout('/api/debug/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration }),
      }, 30_000);
      const data = await res.json() as { ok?: boolean; file?: string; error?: string };
      if (!res.ok) {
        captureBtn.textContent = '❌ ' + (data.error ?? 'Error');
        setTimeout(() => { captureBtn.textContent = '📥 Capture'; captureBtn.disabled = false; }, 3000);
        return;
      }
      // Countdown
      let remaining = duration;
      const timer = setInterval(() => {
        remaining--;
        if (remaining > 0) {
          captureBtn.textContent = `⏳ ${remaining}s...`;
        } else {
          clearInterval(timer);
          captureBtn.textContent = '✅ Saved!';
          setTimeout(() => { captureBtn.textContent = '📥 Capture'; captureBtn.disabled = false; }, 3000);
        }
      }, 1000);
    } catch {
      captureBtn.textContent = '❌ Failed';
      setTimeout(() => { captureBtn.textContent = '📥 Capture'; captureBtn.disabled = false; }, 3000);
    }
  });
}
