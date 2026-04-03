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

export class PrinterState {
  attributes: PrinterAttributes | null = null;
  status: PrinterStatus | null = null;
  canvas: CanvasInfo | null = null;
  files: FileEntry[] = [];
  thumbnail: string | null = null; // base64 PNG
  thumbnailFailed = false; // true when printer returns error (e.g. no embedded thumbnail)
  fileTotalLayers: number | null = null;
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
    this.notify();
  }

  applyDelta(data: Record<string, unknown>): void {
    if (!this.status) {
      this.status = data as unknown as PrinterStatus;
    } else {
      this.status = deepMerge(
        this.status as unknown as Record<string, unknown>,
        data
      ) as unknown as PrinterStatus;
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
        const files = result.files as FileEntry[] | undefined;
        if (files) {
          this.setFiles(files);
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
          this.notify();
        }
        break;
      }
    }
  }

  /** Handle a status event (delta update) */
  handleStatusEvent(data: Record<string, unknown>): void {
    const result = data.result as Record<string, unknown> | undefined;
    if (result) {
      this.applyDelta(result);
    }
  }
}
