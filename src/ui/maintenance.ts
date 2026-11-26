import type { CommandSender } from '../ws-client';
import type { PrinterState } from '../printer-state';
import { $, escapeHtml } from './helpers';
import { toast } from './toast';
import { confirmDialog } from './confirm-dialog';

let maintenanceClient: CommandSender | null = null;

/** Status codes mapped to maintenance operations */
const MAINTENANCE_STATUSES: Record<number, string> = {
  5: 'Auto Leveling',
  6: 'PID Calibrating',
  7: 'Resonance Testing',
  8: 'Self Checking',
};

/** Sub-status codes indicating completion or failure */
const SUB_STATUS_DONE: Record<number, { text: string; ok: boolean }> = {
  2902: { text: 'Leveling Complete', ok: true },
  1505: { text: 'PID Calibration Complete', ok: true },
  1506: { text: 'PID Calibration Failed', ok: false },
  5935: { text: 'Resonance Test Complete', ok: true },
  5936: { text: 'Resonance Test Failed', ok: false },
};

export function setMaintenanceClient(client: CommandSender): void {
  maintenanceClient = client;
}

export function bindMaintenanceControls(): void {
  const btnSelfCheck = $('btn-self-check') as HTMLButtonElement;
  const btnAutoLevel = $('btn-maintenance-level') as HTMLButtonElement;
  const btnVibration = $('btn-maintenance-vibration') as HTMLButtonElement;
  const btnPID = $('btn-maintenance-pid') as HTMLButtonElement;

  btnSelfCheck.addEventListener('click', async () => {
    if (!maintenanceClient) return;
    const ok = await confirmDialog(
      'Run full self-check?\nThis performs auto-level, vibration optimization, and PID calibration sequentially.\nThe printer must be idle (not printing).',
      { title: 'Self-check', confirmLabel: 'Run self-check', danger: true },
    );
    if (!ok || !maintenanceClient) return;
    toast('Starting self-check...', 'info');
    maintenanceClient.sendCommand(1035, {
      ringing_optimize: true,
      pid_check: true,
      auto_bed_leveling: true,
    });
  });

  btnAutoLevel.addEventListener('click', async () => {
    if (!maintenanceClient) return;
    const ok = await confirmDialog('Run auto-level?\nThe printer must be idle (not printing).', {
      title: 'Auto-level',
      confirmLabel: 'Run auto-level',
      danger: true,
    });
    if (!ok || !maintenanceClient) return;
    toast('Starting auto-level...', 'info');
    maintenanceClient.sendCommand(1032, {});
  });

  btnVibration.addEventListener('click', async () => {
    if (!maintenanceClient) return;
    const ok = await confirmDialog(
      'Run vibration optimization (input shaper calibration)?\nThe printer must be idle (not printing).',
      { title: 'Vibration optimization', confirmLabel: 'Run optimization', danger: true },
    );
    if (!ok || !maintenanceClient) return;
    toast('Starting vibration optimization...', 'info');
    maintenanceClient.sendCommand(1033, {});
  });

  btnPID.addEventListener('click', async () => {
    if (!maintenanceClient) return;
    const ok = await confirmDialog(
      'Run PID calibration?\nThe printer must be idle (not printing).',
      {
        title: 'PID calibration',
        confirmLabel: 'Run PID calibration',
        danger: true,
      },
    );
    if (!ok || !maintenanceClient) return;
    toast('Starting PID calibration...', 'info');
    maintenanceClient.sendCommand(1034, {});
  });
}

export function renderMaintenance(state: PrinterState): void {
  const statusEl = $('maintenance-status');
  if (!statusEl) return;

  const s = state.status;
  if (!s) {
    statusEl.innerHTML = '';
    return;
  }

  const machineStatus = s.machine_status?.status;
  const subStatus = s.machine_status?.sub_status;

  // Check if we're in a maintenance mode
  const maintenanceLabel = MAINTENANCE_STATUSES[machineStatus ?? -1];
  if (maintenanceLabel) {
    const subInfo = SUB_STATUS_DONE[subStatus ?? 0];
    let html = `<div class="maintenance-active">`;
    if (subInfo) {
      const cls = subInfo.ok ? 'maintenance-ok' : 'maintenance-fail';
      html += `<span class="${cls}">${subInfo.ok ? '✅' : '❌'} ${escapeHtml(subInfo.text)}</span>`;
    } else {
      html += `<span class="maintenance-running">⏳ ${escapeHtml(maintenanceLabel)}...</span>`;
    }
    html += '</div>';
    statusEl.innerHTML = html;
  } else {
    statusEl.innerHTML = '';
  }

  // Disable buttons during any maintenance operation
  const isBusy = machineStatus != null && machineStatus !== 1;
  const btns = [
    'btn-self-check',
    'btn-maintenance-level',
    'btn-maintenance-vibration',
    'btn-maintenance-pid',
  ];
  for (const id of btns) {
    const btn = $(id) as HTMLButtonElement;
    if (btn) btn.disabled = isBusy;
  }
}
