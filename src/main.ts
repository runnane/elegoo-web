import { WsClient } from './ws-client';
import { PrinterState } from './printer-state';
import { LogStore } from './log-store';
import { ChartStore } from './chart-store';
import {
  renderDashboard,
  renderCanvas,
  renderFiles,
  renderHeader,
  bindControls,
  onCommandResponse,
  registerChart,
  initCharts,
  renderStructuredLog,
  bindStructuredLogControls,
  bindFileControls,
  toast,
  setCanvasClient,
  renderSystemInfo,
  renderTimelapse,
  setTimelapseClient,
  requestTimelapseList,
  showTimelapsePlayer,
  renderGcodePreview,
  renderLayerTimeChart,
  updateServiceStatus,
  fetchTimeout,
  handleAIAnalysis,
  handleAIAlert,
  updateAIStatus,
  applyCardLayout,
  switchToTab,
  currentFileSource,
  currentFileDir,
  handleThumbnailResponse,
  handleInlineThumbnail,
  handleEventLog,
  loadEventLogHistory,
  toggleCameraOverlay,
  renderPrintHistory,
  bindHistoryControls,
  setHistoryClient,
  requestHistory,
  renderMaintenance,
  bindMaintenanceControls,
  setMaintenanceClient,
  renderReports,
  bindReportControls,
  handleFileDetailForPrint,
  bindGcodePreviewControls,
  renderDebugPanel,
  bindDebugPanel,
  trackStateChanges,
} from './ui/dashboard';
import { renderLog, bindLogControls } from './ui/log';
import { installThumbnailFallback } from './ui/helpers';
import type { PrinterStatus, PrinterAttributes, CanvasInfo, FileEntry } from './types';
import {
  COMMAND_METHOD_NAMES,
  classifyCommandOutcome,
  describeCommandError,
  type CommandOutcome,
} from './types';

const state = new PrinterState();
const logStore = new LogStore();
const chartStore = new ChartStore();
let client: WsClient | null = null;
let renderScheduled = false;

// Define chart series
chartStore.defineSeries('nozzle', 'Nozzle', '#ef5350');
chartStore.defineSeries('nozzle_tgt', 'Nozzle Tgt', '#ef535080');
chartStore.defineSeries('bed', 'Bed', '#ffa726');
chartStore.defineSeries('bed_tgt', 'Bed Tgt', '#ffa72680');
chartStore.defineSeries('chamber', 'Chamber', '#66bb6a');
chartStore.defineSeries('fan_model', 'Model', '#4fc3f7');
chartStore.defineSeries('fan_aux', 'Aux', '#66bb6a');
chartStore.defineSeries('fan_case', 'Case', '#ffa726');

// AI chart series — motion detection
chartStore.defineSeries('ai_motion', 'Motion', '#58a6ff');
// AI chart series — classification groups
chartStore.defineSeries('ai_printing', 'Print in Progress', '#3fb950');
chartStore.defineSeries('ai_failure', 'Spaghetti/Failure', '#f85149');
chartStore.defineSeries('ai_empty', 'Empty Bed', '#8b949e');
chartStore.defineSeries('ai_paused', 'Paused/Stopped', '#f0883e');
chartStore.defineSeries('ai_other', 'Other', '#a371f7');

// Speed & flow chart series
chartStore.defineSeries('extrusion_rate', 'Extrusion', '#4fc3f7');

// Register charts
registerChart({
  canvasId: 'chart-temps',
  seriesKeys: ['nozzle', 'nozzle_tgt', 'bed', 'bed_tgt', 'chamber'],
  yMin: 0,
  yMax: 300,
  unit: '°',
});

registerChart({
  canvasId: 'chart-fans',
  seriesKeys: ['fan_model', 'fan_aux', 'fan_case'],
  yMin: 0,
  yMax: 100,
  unit: '%',
});

registerChart({
  canvasId: 'chart-ai-motion',
  seriesKeys: ['ai_motion'],
  yMin: 0,
  yMax: 30,
  unit: '%',
});

registerChart({
  canvasId: 'chart-ai-class',
  seriesKeys: ['ai_printing', 'ai_failure', 'ai_empty', 'ai_paused', 'ai_other'],
  yMin: 0,
  yMax: 100,
  unit: '',
});

registerChart({
  canvasId: 'chart-speed',
  seriesKeys: ['extrusion_rate'],
  yMin: 0,
  unit: 'mm/s',
  averageKeys: ['extrusion_rate'],
});

function scheduleRender(): void {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    if (client) {
      renderHeader(state);
      renderDashboard(state, client);
      renderCanvas(state);
      renderSystemInfo(state);
      renderTimelapse(state);
      renderGcodePreview(state);
      renderLayerTimeChart(state);
      renderPrintHistory(state);
      renderMaintenance(state);
      renderReports();
      renderLog(logStore);
      renderStructuredLog(logStore);
      renderDebugPanel(state);
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
state.subscribe(() => trackStateChanges(state));
logStore.subscribe(scheduleRender);

let controlsBound = false;
let dashboardShown = false;

/** Show the dashboard UI and bind controls (idempotent) */
function showDashboard(): void {
  if (dashboardShown) return;
  dashboardShown = true;
  $('connect-dialog').classList.add('hidden');
  $('dashboard').classList.remove('hidden');
  $('dashboard').dataset.connected = 'true';

  if (!controlsBound) {
    controlsBound = true;
    bindControls(client!);
    bindLogControls(logStore);
    bindStructuredLogControls(logStore);
    bindFileControls(client!);
    setCanvasClient(client!);
    setTimelapseClient(client!);
    setHistoryClient(client!);
    setMaintenanceClient(client!);
    $('timelapse-refresh').addEventListener('click', () => requestTimelapseList());
    bindHistoryControls();
    bindMaintenanceControls();
    bindReportControls();
    bindGcodePreviewControls();
    bindDebugPanel();
    $('timelapse-close').addEventListener('click', () => {
      const player = $('timelapse-player') as HTMLVideoElement;
      player.pause();
      player.src = '';
      $('timelapse-player-wrap').classList.add('hidden');
    });
    $('btn-reset-layer-data').addEventListener('click', async () => {
      if (!confirm('Reset all layer duration data?')) return;
      try {
        const res = await fetchTimeout('/api/layer-data', { method: 'DELETE' });
        if (res.ok) {
          toast('Layer data reset', 'success');
        } else {
          toast('Reset failed', 'error');
        }
      } catch {
        toast('Network error', 'error');
      }
    });
    initCharts(chartStore);

    // Camera click-to-expand
    const cameraWrap = $('camera-wrap');
    const cameraModal = $('camera-modal');
    const cameraModalImg = $('camera-modal-img') as HTMLImageElement;
    const cameraFeed = $('camera-feed') as HTMLImageElement;
    cameraWrap.addEventListener('click', () => {
      if (!cameraFeed.src || cameraFeed.alt === 'Camera off') return;
      cameraModalImg.src = cameraFeed.src;
      cameraModal.classList.remove('hidden');
      cameraModal.focus();
    });
    const closeModal = () => {
      cameraModal.classList.add('hidden');
      cameraModalImg.src = '';
    };
    $('camera-modal-close').addEventListener('click', (e) => {
      e.stopPropagation();
      closeModal();
    });
    cameraModal.addEventListener('click', closeModal);
    cameraModal.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Escape') closeModal();
    });

    // Camera expand toggle
    const cameraCard = $('camera-card');
    const expandBtn = $('camera-expand-btn');
    expandBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const expanded = cameraCard.classList.toggle('camera-expanded');
      expandBtn.textContent = expanded ? '⤡ Collapse' : '⤢ Expand';
    });

    // Camera overlay toggle
    const overlayBtn = $('camera-overlay-btn');
    overlayBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleCameraOverlay();
    });

    // Camera snapshot download with retry (max 3 attempts, exponential backoff)
    const snapshotBtn = $('camera-snapshot-btn') as HTMLButtonElement;
    snapshotBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (snapshotBtn.disabled) return;
      snapshotBtn.disabled = true;
      snapshotBtn.textContent = '⏳ ...';
      try {
        let res: Response | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt > 0) {
            snapshotBtn.textContent = `⏳ retry ${attempt}...`;
            await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
          }
          try {
            res = await fetchTimeout('/api/snapshot');
            if (res.ok) break;
          } catch {
            res = undefined;
          }
        }
        if (!res || !res.ok) {
          toast('Snapshot failed', 'error');
          return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        a.download = `snapshot-${ts}.jpg`;
        a.click();
        URL.revokeObjectURL(url);
        toast('Snapshot saved', 'success');
      } catch {
        toast('Snapshot failed', 'error');
      } finally {
        snapshotBtn.disabled = false;
        snapshotBtn.textContent = '📸 Snapshot';
      }
    });
  }
}

/** Called when printer MQTT is confirmed connected */
function onPrinterConnected(sn: string): void {
  console.log(`Connected to printer SN: ${sn}`);
  toast(`Connected to printer ${sn}`, 'success');
  showDashboard();

  // Request data that the service may not have cached yet
  client!.sendCommand(1044, { storage_media: 'local', dir: '/', offset: 0, limit: 50 });
  client!.sendCommand(1048, { storage_media: 'local' });
  client!.sendCommand(1062, {});
  client!.sendCommand(2006, {});
  requestHistory();
}

/**
 * Toast the outcome of a write command, and hand the classification back so a caller
 * with something more specific to say on success can branch on it.
 *
 * Before ELEG-40 a refused command produced nothing at all: `guardedSend` re-enabled the
 * button on its timer and the user reasonably concluded it had worked. `busy` is a
 * warning rather than an error because it is not a failure — the printer simply could
 * not take the command this instant.
 *
 * **Nothing is retried automatically, deliberately.** These are writes to a physical
 * machine, and a re-sent `move` that lands thirty seconds later — after the user has
 * given up and put a hand on the bed — is worse than one that visibly did nothing. The
 * user is told they can press it again; pressing it is theirs to decide.
 */
function reportCommandOutcome(method: number, data: unknown): CommandOutcome {
  const result = (data as Record<string, unknown>).result as Record<string, unknown> | undefined;
  const code = result?.error_code as number | undefined;
  const outcome = classifyCommandOutcome(code);
  const label = COMMAND_METHOD_NAMES[method] ?? `Command ${method}`;

  if (outcome === 'busy') {
    toast(`${label}: printer is busy — try again in a moment`, 'warning');
  } else if (outcome === 'rejected') {
    toast(`${label} refused: ${describeCommandError(code)}`, 'warning');
  } else if (outcome === 'error') {
    toast(`${label} failed: ${describeCommandError(code)}`, 'error');
  }
  return outcome;
}

function connectToService(): void {
  // Build WS URL relative to current page (works with Vite proxy and production)
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const serviceUrl = `${wsProtocol}//${location.host}/ws`;

  $('connect-error').textContent = '';
  ($('connect-btn') as HTMLButtonElement).disabled = true;
  ($('connect-btn') as HTMLButtonElement).textContent = 'Connecting...';

  client = new WsClient({
    serviceUrl,
    onStateChange(connState) {
      updateConnectionBadge(connState);

      if (connState === 'disconnected' && dashboardShown) {
        toast('Connection lost — reconnecting...', 'warning');
      }

      if (connState === 'error' && !dashboardShown) {
        ($('connect-btn') as HTMLButtonElement).disabled = false;
        ($('connect-btn') as HTMLButtonElement).textContent = 'Connect';
        $('connect-error').textContent =
          'Cannot reach service. Ensure the elegoo-web service is running.';
        toast('Service connection failed', 'error');
      }
    },
    onRegistered(sn, _printerIp) {
      onPrinterConnected(sn);
    },
    onInit(initData) {
      // Hydrate state from service snapshot
      if (initData.status) {
        state.setFullStatus(initData.status as PrinterStatus);
      }
      if (initData.attributes) {
        state.setAttributes(initData.attributes as PrinterAttributes);
      }
      if (initData.canvas) {
        state.setCanvas(initData.canvas as CanvasInfo);
      }
      if (initData.files && Array.isArray(initData.files)) {
        state.setFiles(initData.files as FileEntry[]);
      }
      if (initData.thumbnail) {
        state.thumbnail = initData.thumbnail as string;
      }
      if (initData.fileTotalLayers != null) {
        state.fileTotalLayers = initData.fileTotalLayers as number;
      }
      if (initData.systemInfo) {
        state.systemInfo = initData.systemInfo as Record<string, unknown>;
      }
      if (initData.layerTimes && Array.isArray(initData.layerTimes)) {
        const lt = initData.layerTimes as Array<{
          layer: number;
          duration: number;
          timestamp: number;
        }>;
        if (lt.length > 0) {
          const lastEntry = lt[lt.length - 1];
          state.restoreLayerData(lt, lastEntry.layer, lastEntry.timestamp);
        }
      }
      if (initData.filamentUsage && Array.isArray(initData.filamentUsage)) {
        state.filamentUsage = initData.filamentUsage as typeof state.filamentUsage;
      }
      if (initData.zones) {
        state.zones = initData.zones as typeof state.zones;
      }
      if (initData.serviceStatus) {
        updateServiceStatus(initData.serviceStatus as Record<string, unknown>);
        const ss = initData.serviceStatus as Record<string, unknown>;
        if (typeof ss.ai === 'string') {
          updateAIStatus(ss.ai, ss.aiConfig as Record<string, unknown> | null);
        }
      }
      // Load chart history from service (replaces localStorage persistence)
      if (initData.chartHistory && Array.isArray(initData.chartHistory)) {
        chartStore.loadHistory(
          initData.chartHistory as Array<{ t: number; values: Record<string, number> }>,
        );
      }
      // Load AI chart history from service
      if (initData.aiChartHistory && Array.isArray(initData.aiChartHistory)) {
        const aiPoints = initData.aiChartHistory as Array<{
          t: number;
          motion: number;
          scores: Record<string, number>;
        }>;
        // Convert AI chart points into the generic chart format for loadHistory merge
        const converted = aiPoints.map((p) => ({
          t: p.t,
          values: {
            ai_motion: p.motion,
            ai_printing: p.scores['Print in Progress'] ?? 0,
            ai_failure: p.scores['Spaghetti/Failure'] ?? 0,
            ai_empty: p.scores['Empty Bed'] ?? 0,
            ai_paused: p.scores['Paused/Stopped'] ?? 0,
            ai_other: p.scores['Other'] ?? 0,
          },
        }));
        // Push into existing series without clearing (chart history already loaded above)
        for (const point of converted) {
          chartStore.pushPoint(point.t, point.values);
        }
      }
      // Load event log history
      if (initData.eventLog && Array.isArray(initData.eventLog)) {
        loadEventLogHistory(
          initData.eventLog as Array<{ ts: number; event: Record<string, unknown> }>,
        );
      }

      // Always show dashboard when service responds — even if printer MQTT is down
      showDashboard();
      const printerConnected = initData.connected as boolean;
      if (!printerConnected) {
        updateConnectionBadge('disconnected');
      }
      scheduleRender();
    },
    onMessage(method, data) {
      state.handleResponse(method, data as Record<string, unknown>);
      onCommandResponse(method);

      // Writes report their own failures; reads do not (a poll that comes back busy is
      // re-polled seconds later and is not worth a toast). `ok` for anything unlisted,
      // so the success paths below read the same either way.
      const outcome =
        COMMAND_METHOD_NAMES[method] !== undefined ? reportCommandOutcome(method, data) : 'ok';

      if (method === 1044 && client) {
        requestAnimationFrame(() => renderFiles(state, client!));
      }
      if (method === 1047 && client) {
        // After file delete, refresh file list and capacity
        const result = (data as Record<string, unknown>).result as
          | Record<string, unknown>
          | undefined;
        const errorCode = result?.error_code as number | undefined;
        if (errorCode === 0) {
          toast('File deleted', 'success');
        } else if (classifyCommandOutcome(errorCode) === 'busy') {
          toast('Cannot delete — printer is busy. Try again in a moment.', 'warning');
        } else {
          toast(`Delete failed: ${describeCommandError(errorCode)}`, 'error');
        }
        client.sendCommand(1044, {
          storage_media: currentFileSource(),
          dir: currentFileDir(),
          offset: 0,
          limit: 200,
        });
        client.sendCommand(1048, { storage_media: currentFileSource() });
      }
      if (method === 1048 && client) {
        requestAnimationFrame(() => renderFiles(state, client!));
      }
      if (method === 1045) {
        const purpose = state._lastThumbnailPurpose;
        if (purpose === 'popup') {
          handleThumbnailResponse(state._lastRawThumbnail);
        } else if (purpose === 'inline') {
          handleInlineThumbnail(state._lastRawThumbnail);
        }
        // 'print' purpose is handled in printer-state.ts directly
      }
      if (method === 1046) {
        handleFileDetailForPrint(state);
      }
      // After move/home, request fresh status and flash position
      if ((method === 1026 || method === 1027) && client && outcome === 'ok') {
        client.sendCommand(1002, {});
        const pos = state.status?.gcode_move;
        if (pos) {
          const x = pos.x?.toFixed(1) ?? '--';
          const y = pos.y?.toFixed(1) ?? '--';
          const z = pos.z?.toFixed(1) ?? '--';
          toast(`Position: X${x} Y${y} Z${z}`, 'success');
        }
        // Flash the position display
        for (const id of ['pos-x', 'pos-y', 'pos-z']) {
          const el = document.getElementById(id);
          if (el) {
            el.classList.remove('pos-flash');
            void el.offsetWidth; // force reflow
            el.classList.add('pos-flash');
          }
        }
      }
      if (method === 1051) {
        const r1051 = (data as Record<string, unknown>).result as
          | Record<string, unknown>
          | undefined;
        const err1051 = r1051?.error_code as number | undefined;
        if (err1051 === 0) {
          if (state.videoUrl) {
            showTimelapsePlayer(state.videoUrl);
          } else {
            toast('Timelapse export started — video will be generated', 'info');
          }
        } else if (classifyCommandOutcome(err1051) === 'busy') {
          toast('Cannot export timelapse — printer is busy. Try when idle.', 'warning');
          requestAnimationFrame(() => renderTimelapse(state));
        } else {
          toast(`Timelapse export failed: ${describeCommandError(err1051)}`, 'error');
          requestAnimationFrame(() => renderTimelapse(state));
        }
      }
      if (method === 1050 && state.videoUrl) {
        showTimelapsePlayer(state.videoUrl);
      }
      // Only on success. These used to toast "started" whatever came back, so a
      // calibration the printer had refused as busy still read as under way (ELEG-40).
      if (outcome === 'ok') {
        if (method === 1032) {
          toast('Auto-level started', 'success');
        }
        if (method === 1033) {
          toast('Vibration optimization started', 'success');
        }
        if (method === 1034) {
          toast('PID calibration started', 'success');
        }
        if (method === 1035) {
          toast('Self-check started', 'success');
        }
      }
      if (method === 1036) {
        requestAnimationFrame(() => renderPrintHistory(state));
        requestAnimationFrame(() => renderTimelapse(state));
      }
      if (method === 2003) {
        const result = (data as Record<string, unknown>).result as
          | Record<string, unknown>
          | undefined;
        const errorCode = result?.error_code as number | undefined;
        if (errorCode === 0) {
          toast('Filament saved', 'success');
          if (client) client.sendCommand(2005, {});
        } else if (classifyCommandOutcome(errorCode) === 'busy') {
          toast('Cannot edit filament while printing — printer is busy', 'warning');
        } else {
          toast(`Filament save failed: ${describeCommandError(errorCode)}`, 'error');
        }
      }
    },
    onStatusEvent(data) {
      state.handleStatusEvent(data as Record<string, unknown>);
      // Auto-refresh timelapse list when video generation completes or fails
      const ms = (data as Record<string, unknown>).result as Record<string, unknown> | undefined;
      const subStatus = (ms?.machine_status as Record<string, unknown>)?.sub_status as
        | number
        | undefined;
      if (subStatus === 3021 || subStatus === 3022) {
        // Timelapse generation complete/failed — refresh history to get updated URLs
        toast(
          subStatus === 3021 ? 'Timelapse video ready' : 'Timelapse export failed',
          subStatus === 3021 ? 'success' : 'error',
        );
        requestTimelapseList();
      }
    },
    onRawMessage(direction, topic, data) {
      logStore.add(direction, topic, data);
    },
    onServiceStatus(data) {
      updateServiceStatus(data);
      if (typeof data.ai === 'string') {
        updateAIStatus(data.ai, data.aiConfig as Record<string, unknown> | null);
      }
    },
    onChartData(t, values) {
      chartStore.pushPoint(t, values);
    },
    onAIAnalysis(data) {
      handleAIAnalysis(data);
    },
    onAIAlert(data) {
      handleAIAlert(data);
    },
    onAIChartData(t, motion, scores) {
      chartStore.pushPoint(t, {
        ai_motion: motion,
        ai_printing: scores['Print in Progress'] ?? 0,
        ai_failure: scores['Spaghetti/Failure'] ?? 0,
        ai_empty: scores['Empty Bed'] ?? 0,
        ai_paused: scores['Paused/Stopped'] ?? 0,
        ai_other: scores['Other'] ?? 0,
      });
    },
    onEventLog(entry) {
      handleEventLog(entry);
    },
    onLayerTime(entry) {
      state.addLayerTime(entry);
    },
    onLayerClear() {
      state.clearLayerTimes();
    },
    onFilamentUsage(usage) {
      state.filamentUsage = usage;
      scheduleRender();
    },
    onZoneChange(data) {
      state.zones.previous = data.from as typeof state.zones.current;
      state.zones.current = data.to as typeof state.zones.current;
      state.zones.enteredAt = data.timestamp;
      if (state.zones.history.length > 50) state.zones.history.shift();
      state.zones.history.push({
        zone: data.from as typeof state.zones.current,
        entered: 0,
        exited: data.timestamp,
      });
      scheduleRender();
    },
  });

  client.connect();

  // Wire auto-report gap detection: request full status on missed sequence IDs
  state.setRefreshCallback(() => {
    client?.sendCommand(1002, {});
  });
}

// Connect button handler — now connects to the local service
$('connect-btn').addEventListener('click', () => {
  connectToService();
});

// A corrupt or truncated thumbnail otherwise renders as the browser's broken-image
// icon. One delegated listener covers every thumbnail, including the ones built as
// HTML strings (ELEG-42).
installThumbnailFallback();

// Auto-connect on page load
connectToService();

// Ship uncaught client errors to server for logging
function reportClientError(
  message: string,
  stack?: string,
  url?: string,
  line?: number,
  col?: number,
): void {
  try {
    navigator.sendBeacon('/api/client-error', JSON.stringify({ message, stack, url, line, col }));
  } catch {
    /* ignore */
  }
}
window.addEventListener('error', (e) => {
  reportClientError(e.message, e.error?.stack, e.filename, e.lineno, e.colno);
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason instanceof Error ? e.reason.message : String(e.reason);
  const stack = e.reason instanceof Error ? e.reason.stack : undefined;
  reportClientError(msg, stack);
});

// Tab navigation
document.querySelectorAll('.main-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = (btn as HTMLElement).dataset.tab as
      | 'dashboard'
      | 'settings'
      | 'tools'
      | 'help'
      | 'debug';
    switchToTab(tab);
  });
});

// Apply saved card layout
applyCardLayout();

// ---- Sidebar resize handle ----
{
  const handle = document.getElementById('sidebar-resize-handle');
  const sidebar = document.getElementById('dashboard-sidebar');
  const SIDEBAR_KEY = 'elegoo-web-sidebar-width';
  const SIDEBAR_HIDDEN_KEY = 'elegoo-web-sidebar-hidden';

  // Restore saved sidebar width
  const savedWidth = localStorage.getItem(SIDEBAR_KEY);
  if (savedWidth && sidebar) sidebar.style.width = savedWidth;

  // Restore sidebar visibility
  const wasHidden = localStorage.getItem(SIDEBAR_HIDDEN_KEY) === '1';
  if (wasHidden && sidebar) sidebar.classList.add('sidebar-hidden');

  if (handle && sidebar) {
    let startX = 0;
    let startW = 0;

    const onMove = (e: MouseEvent) => {
      const newW = Math.max(260, Math.min(600, startW + (e.clientX - startX)));
      sidebar.style.width = newW + 'px';
    };
    const onUp = () => {
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem(SIDEBAR_KEY, sidebar.style.width);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startW = sidebar.getBoundingClientRect().width;
      handle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // Sidebar toggle button
  const toggleBtn = document.getElementById('sidebar-toggle');
  if (toggleBtn && sidebar) {
    toggleBtn.addEventListener('click', () => {
      sidebar.classList.toggle('sidebar-hidden');
      const hidden = sidebar.classList.contains('sidebar-hidden');
      localStorage.setItem(SIDEBAR_HIDDEN_KEY, hidden ? '1' : '0');
    });
  }
}

// Register PWA service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {
    // SW registration failed — non-critical
  });
}
