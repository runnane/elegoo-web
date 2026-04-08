import type { PrinterAttributes, PrinterStatus, CanvasInfo, FileEntry } from './types';

export type StateListener = () => void;

/** Deep-merge delta updates into base state */
function deepMerge(base: Record<string, unknown>, update: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };
  for (const key of Object.keys(update)) {
    const bVal = result[key];
    const uVal = update[key];
    if (bVal && uVal && typeof bVal === 'object' && typeof uVal === 'object' && !Array.isArray(uVal)) {
      result[key] = deepMerge(bVal as Record<string, unknown>, uVal as Record<string, unknown>);
    } else {
      result[key] = uVal;
    }
  }
  return result;
}

/** Map CC2 task status to human-readable string */
function mapTaskStatus(status: number | string | undefined): string {
  if (typeof status === 'string') return status;
  switch (status) {
    case 0: return 'unknown';
    case 1: return 'printing';
    case 2: return 'completed';
    case 3: return 'failed';
    case 4: return 'stopped';
    default: return 'unknown';
  }
}

export class PrinterState {
  attributes: PrinterAttributes | null = null;
  status: PrinterStatus | null = null;
  canvas: CanvasInfo | null = null;
  files: FileEntry[] = [];
  thumbnail: string | null = null; // base64 PNG
  thumbnailFailed = false; // true when printer returns error (e.g. no embedded thumbnail)
  fileTotalLayers: number | null = null;
  fileFilamentUsed: number | null = null;
  /** Color map from last file detail (method 1046) for multi-color printing */
  colorMap: Array<{ t: number; color: string; name: string }> = [];
  /** Full file detail from last 1046 response */
  lastFileDetail: { filename?: string; print_time?: number; layer?: number; thumbnail?: string } | null = null;
  systemInfo: Record<string, unknown> | null = null;
  storageCapacity: { total: number; free: number; used: number } | null = null;
  monoFilament: Record<string, unknown> | null = null;
  /** Layer timing: records [layer, durationSec] for each completed layer */
  layerTimes: Array<{ layer: number; duration: number; timestamp: number }> = [];
  /** Per-spool filament usage (from server) */
  filamentUsage: Array<{ trayKey: string; filamentType: string; color: string; extruded_mm: number; grams: number; meters: number }> = [];
  timelapseList: Record<string, unknown>[] = [];
  videoUrl: string | null = null;
  bedMesh: number[][] | null = null;
  /** Print history from method 1036 */
  printHistory: Array<{ uuid: string; filename: string; status: string; begin_time: number; end_time: number }> = [];
  printHistoryTotal = 0;
  /** Auto-report sequence tracking for gap detection */
  private lastAutoReportId: number | null = null;
  private refreshCallback: (() => void) | null = null;
  private listeners: StateListener[] = [];

  subscribe(listener: StateListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  setAttributes(data: PrinterAttributes): void {
    this.attributes = data;
    this.notify();
  }

  setFullStatus(data: PrinterStatus): void {
    this.status = data;
    this.extractBedMesh(data as unknown as Record<string, unknown>);
    this.notify();
  }

  /** Extract bed mesh data from any response/status that may contain it */
  private extractBedMesh(data: Record<string, unknown>): void {
    const meshData = (data.bed_mesh ?? data.bed_level_info) as Record<string, unknown> | undefined;
    if (meshData) {
      const probed = (meshData.probed_matrix ?? meshData.mesh_matrix ?? meshData.data) as number[][] | undefined;
      if (probed && Array.isArray(probed) && probed.length > 0) {
        this.bedMesh = probed;
      }
    }
  }

  applyDelta(data: Record<string, unknown>): void {
    // Normalize firmware field name variations
    if ('gcode_move_inf' in data && !('gcode_move' in data)) {
      data.gcode_move = data.gcode_move_inf;
      delete data.gcode_move_inf;
    }

    if (!this.status) {
      this.status = data as unknown as PrinterStatus;
    } else {
      this.status = deepMerge(
        this.status as unknown as Record<string, unknown>,
        data
      ) as unknown as PrinterStatus;
    }

    // Track layer changes for layer-time chart — handled server-side now

    // Capture bed mesh data if present
    this.extractBedMesh(data);

    // Capture mono filament info if present in delta
    const monoInfo = data.mono_filament_info as Record<string, unknown> | undefined;
    if (monoInfo) {
      this.monoFilament = monoInfo;
    }

    // Capture canvas info updates from delta (active tray changes, etc.)
    const canvasDelta = data.canvas_info as CanvasInfo | undefined;
    if (canvasDelta) {
      if (this.canvas) {
        this.canvas = deepMerge(
          this.canvas as unknown as Record<string, unknown>,
          canvasDelta as unknown as Record<string, unknown>
        ) as unknown as CanvasInfo;
      } else {
        this.canvas = canvasDelta;
      }
    }

    this.notify();
  }

  setCanvas(data: CanvasInfo): void {
    this.canvas = data;
    this.notify();
  }

  setFiles(files: FileEntry[]): void {
    this.files = files;
    this.notify();
  }

  /** Handle a method response from the printer */
  handleResponse(method: number, data: Record<string, unknown>): void {
    const result = data.result as Record<string, unknown> | undefined;
    if (!result) return;

    // Normalize firmware field name variations
    if ('gcode_move_inf' in result && !('gcode_move' in result)) {
      result.gcode_move = result.gcode_move_inf;
      delete result.gcode_move_inf;
    }

    switch (method) {
      case 1001: // GET_ATTRIBUTES
        this.setAttributes(result as unknown as PrinterAttributes);
        break;
      case 1002: // GET_STATUS
        this.setFullStatus(result as unknown as PrinterStatus);
        break;
      case 2005: { // GET_CANVAS_STATUS
        const canvasInfo = result.canvas_info as CanvasInfo | undefined;
        if (canvasInfo) {
          this.setCanvas(canvasInfo);
        }
        break;
      }
      case 1044: { // GET_FILE_LIST
        const fileList = result.file_list as FileEntry[] | undefined;
        if (fileList) {
          this.setFiles(fileList);
        }
        break;
      }
      case 1045: { // GET_FILE_THUMBNAIL
        const errorCode = result.error_code as number | undefined;
        const thumb = result.thumbnail as string | undefined;
        if (thumb && errorCode === 0) {
          this.thumbnail = thumb;
          this.thumbnailFailed = false;
        } else {
          this.thumbnailFailed = true;
        }
        this.notify();
        break;
      }
      case 1046: { // GET_FILE_DETAIL
        const layers = (result.TotalLayers ?? result.layer ?? result.total_layer) as number | undefined;
        if (layers != null) {
          this.fileTotalLayers = layers;
        }
        const filament = (result.total_filament_used ?? result.TotalFilamentUsed) as number | undefined;
        if (filament != null) {
          this.fileFilamentUsed = filament;
        }
        const cm = result.color_map as Array<{ t: number; color: string; name: string }> | undefined;
        this.colorMap = Array.isArray(cm) ? cm : [];
        this.lastFileDetail = {
          filename: result.filename as string | undefined,
          print_time: (result.print_time ?? result.PrintTime) as number | undefined,
          layer: layers ?? undefined,
          thumbnail: result.thumbnail as string | undefined,
        };
        this.notify();
        break;
      }
      case 1062: { // GET_SYSTEM_INFO
        const errorCode = result.error_code as number | undefined;
        if (errorCode === 0) {
          const info = { ...result };
          delete info.error_code;
          this.systemInfo = info;
          this.notify();
        }
        break;
      }
      case 1048: { // GET_DISK_INFO
        const errorCode = result.error_code as number | undefined;
        if (errorCode === 0) {
          this.storageCapacity = {
            total: result.total_bytes as number ?? 0,
            free: result.free_bytes as number ?? 0,
            used: result.used_bytes as number ?? 0,
          };
          this.notify();
        }
        break;
      }
      case 2006: { // GET_MONO_FILAMENT
        const errorCode = result.error_code as number | undefined;
        if (errorCode === 0) {
          const info = result.mono_filament_info as Record<string, unknown> | undefined;
          if (info) {
            this.monoFilament = info;
          } else {
            // The whole result might be the filament info
            const cleaned = { ...result };
            delete cleaned.error_code;
            if (Object.keys(cleaned).length > 0) {
              this.monoFilament = cleaned;
            }
          }
          this.notify();
        }
        break;
      }
      case 1050: { // GET_VIDEO_URL
        const errorCode = result.error_code as number | undefined;
        const url = result.url as string | undefined;
        if (errorCode === 0 && url) {
          this.videoUrl = url;
          this.notify();
        }
        break;
      }
      case 1051: { // GET_TIMELAPSE
        const errorCode = result.error_code as number | undefined;
        const list = result.file_list as Record<string, unknown>[] | undefined;
        if (errorCode === 0 && list) {
          this.timelapseList = list;
          this.notify();
        }
        break;
      }
      case 1036: { // PRINT_TASK_LIST
        const errorCode = result.error_code as number | undefined;
        if (errorCode === 0) {
          const tasks = result.task_list as Array<Record<string, unknown>> | undefined;
          const total = result.total as number | undefined;
          if (tasks) {
            this.printHistory = tasks.map(t => ({
              uuid: (t.uuid as string) || '',
              filename: (t.filename ?? t.task_name ?? t.name ?? '') as string,
              status: mapTaskStatus(t.status as number | string | undefined),
              begin_time: (t.begin_time as number) || 0,
              end_time: (t.end_time as number) || 0,
            }));
            this.printHistoryTotal = total ?? this.printHistory.length;
          }
          this.notify();
        }
        break;
      }
    }
  }

  private trackLayerChange(_layer: number | undefined): void {
    // Layer tracking is now handled server-side; this is a no-op.
    // Layer data arrives via WS layer_time / layer_clear messages.
  }

  /** Getters for persistence */
  getLastLayer(): number {
    const last = this.layerTimes[this.layerTimes.length - 1];
    return last?.layer ?? 0;
  }
  getLastLayerTime(): number {
    const last = this.layerTimes[this.layerTimes.length - 1];
    return last?.timestamp ?? 0;
  }

  /** Add a single layer time entry (from server WS message) */
  addLayerTime(entry: { layer: number; duration: number; timestamp: number }): void {
    this.layerTimes.push(entry);
    if (this.layerTimes.length > 2000) this.layerTimes.shift();
    this.notify();
  }

  /** Clear all layer data (new print started on server) */
  clearLayerTimes(): void {
    this.layerTimes = [];
    this.notify();
  }

  /** Restore layer data from persistence (init snapshot from server) */
  restoreLayerData(
    layerTimes: Array<{ layer: number; duration: number; timestamp: number }>,
    _lastLayer: number,
    _lastLayerTime: number,
  ): void {
    this.layerTimes = layerTimes;
  }

  /** Register callback to request full status refresh (method 1002) on auto-report gaps */
  setRefreshCallback(cb: () => void): void {
    this.refreshCallback = cb;
  }

  /** Handle a status event (delta update) with auto-report gap detection */
  handleStatusEvent(data: Record<string, unknown>): void {
    const result = data.result as Record<string, unknown> | undefined;
    if (!result) return;

    // Auto-report gap detection: track auto_report_id sequence
    const reportId = data.auto_report_id as number | undefined;
    if (reportId != null) {
      if (this.lastAutoReportId != null && reportId !== this.lastAutoReportId + 1) {
        // Gap detected — request full status refresh
        console.warn(`Auto-report gap: expected ${this.lastAutoReportId + 1}, got ${reportId}. Requesting full refresh.`);
        this.refreshCallback?.();
      }
      this.lastAutoReportId = reportId;
    }

    this.applyDelta(result);
  }
}
