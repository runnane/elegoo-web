import { CC2MqttClient } from './mqtt-client';
import { PrinterState } from './printer-state';
import { renderDashboard, renderCanvas, renderFiles, renderHeader, bindControls } from './ui/dashboard';

const state = new PrinterState();
let client: CC2MqttClient | null = null;
let renderScheduled = false;

function scheduleRender(): void {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    if (client) {
      renderHeader(state);
      renderDashboard(state, client);
      renderCanvas(state);
    }
  });
}

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function updateConnectionBadge(status: string): void {
  const badge = $('connection-status');
  badge.textContent = status.charAt(0).toUpperCase() + status.slice(1);
  badge.className = `status-badge ${status}`;
}

// Subscribe to state changes
state.subscribe(scheduleRender);

// Connect button handler
$('connect-btn').addEventListener('click', () => {
  const ip = ($('printer-ip') as HTMLInputElement).value.trim();
  const password = ($('printer-password') as HTMLInputElement).value || '123456';

  if (!ip) {
    $('connect-error').textContent = 'Please enter a printer IP address';
    return;
  }

  $('connect-error').textContent = '';
  ($('connect-btn') as HTMLButtonElement).disabled = true;
  ($('connect-btn') as HTMLButtonElement).textContent = 'Connecting...';

  client = new CC2MqttClient({
    printerIp: ip,
    password,
    onStateChange(connState) {
      updateConnectionBadge(connState);

      if (connState === 'error' || connState === 'disconnected') {
        ($('connect-btn') as HTMLButtonElement).disabled = false;
        ($('connect-btn') as HTMLButtonElement).textContent = 'Connect';
      }

      if (connState === 'error') {
        $('connect-error').textContent = 'Connection failed. Check IP and ensure printer is in LAN-only mode.';
      }
    },
    onRegistered(sn) {
      console.log(`Registered with printer SN: ${sn}`);
      // Show dashboard, hide connect dialog
      $('connect-dialog').classList.add('hidden');
      $('dashboard').classList.remove('hidden');
      // Bind control handlers
      bindControls(client!);
      // Request file list
      client!.sendCommand(1044, { storage_media: 'local', path: '/', page: 1, page_size: 50 });
    },
    onMessage(method, data) {
      state.handleResponse(method, data as Record<string, unknown>);
      // Render files when file list arrives
      if (method === 1044 && client) {
        requestAnimationFrame(() => renderFiles(state, client!));
      }
    },
    onStatusEvent(data) {
      state.handleStatusEvent(data as Record<string, unknown>);
    },
  });

  client.connect();
});

// Allow Enter key in IP field
$('printer-ip').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('connect-btn').click();
});
