/** Gcode preview — 3D toolpath visualization using gcode-preview library */

import { init, type WebGLPreview } from 'gcode-preview';
import type { PrinterState } from '../printer-state';
import { $, fetchTimeout } from './helpers';

let preview: WebGLPreview | null = null;
let loadedFile = '';
let loading = false;
let lastEndLayer = -1;
let followMode = true;
/** Track last known printer file so we auto-load when print starts */
let lastPrinterFile = '';

// CC2 Centauri Carbon 2 build volume (mm)
const BUILD_VOLUME = { x: 300, y: 300, z: 350 };

/** Exported for main.ts to call on each render frame */
export function renderGcodePreview(state: PrinterState): void {
  const s = state.status;
  const ps = s?.print_status;
  const isPrinting = s?.machine_status?.status === 2;
  const filename = ps?.filename || '';

  // Auto-load when a new print starts
  if (isPrinting && filename && filename !== lastPrinterFile) {
    lastPrinterFile = filename;
    if (filename !== loadedFile) {
      loadGcode(filename);
    }
  }

  // When print stops, keep the preview but reset tracking
  if (!isPrinting && lastPrinterFile) {
    lastPrinterFile = '';
  }

  updateInfo(state);

  // Follow mode: update visible layers to match print progress
  if (!preview || !followMode) return;
  const currentLayer = ps?.current_layer ?? 0;
  if (isPrinting && currentLayer > 0 && currentLayer !== lastEndLayer) {
    lastEndLayer = currentLayer;
    preview.endLayer = currentLayer;
    preview.render();
  }
}

/** Initialize the 3D preview on the canvas */
function initPreview(): WebGLPreview | null {
  const canvas = $('gcode-preview-canvas') as HTMLCanvasElement | null;
  if (!canvas) return null;

  // Dispose previous instance
  if (preview) {
    try { preview.dispose(); } catch { /* ignore */ }
    preview = null;
  }

  const p = init({
    canvas,
    backgroundColor: '#1e1e2e',
    extrusionColor: '#2196f3',
    topLayerColor: '#ef5350',
    travelColor: '#444460',
    buildVolume: BUILD_VOLUME,
    lineWidth: 2,
    renderExtrusion: true,
    renderTravel: false,
    initialCameraPosition: [-200, 350, 350],
  });

  lastEndLayer = -1;
  return p;
}

/** Load gcode file from the server download proxy */
export async function loadGcode(filename: string, source = 'local'): Promise<void> {
  if (loading) return;

  const statusEl = $('gcode-preview-status');
  const loadBtn = $('btn-load-gcode') as HTMLButtonElement | null;

  try {
    loading = true;
    if (loadBtn) loadBtn.disabled = true;
    if (statusEl) statusEl.textContent = 'Downloading gcode…';

    const url = `/api/files/download?file=${encodeURIComponent(filename)}&source=${encodeURIComponent(source)}`;
    const resp = await fetchTimeout(url, undefined, 120_000);
    if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);

    if (statusEl) statusEl.textContent = 'Parsing gcode…';

    const gcode = await resp.text();

    // Initialize clean preview
    preview = initPreview();
    if (!preview) {
      if (statusEl) statusEl.textContent = 'Canvas not found';
      return;
    }

    // Process gcode (this parses + renders)
    preview.processGCode(gcode);
    loadedFile = filename;

    // Set layer slider range
    const slider = $('gcode-layer-slider') as HTMLInputElement | null;
    if (slider) {
      slider.max = String(preview.maxLayerIndex);
      slider.value = String(preview.maxLayerIndex);
    }

    // Show total layers
    const totalLayers = preview.layers.length;
    if (statusEl) statusEl.textContent = `${totalLayers} layers · ${shortName(filename)}`;
  } catch (err) {
    console.error('Gcode preview load error:', err);
    if (statusEl) statusEl.textContent = `Error: ${(err as Error).message}`;
  } finally {
    loading = false;
    if (loadBtn) loadBtn.disabled = false;
  }
}

/** Update the info bar below the 3D view */
function updateInfo(state: PrinterState): void {
  const infoEl = $('gcode-preview-info');
  if (!infoEl) return;

  const s = state.status;
  const ps = s?.print_status;
  const isPrinting = s?.machine_status?.status === 2;

  if (!preview || !loadedFile) {
    infoEl.textContent = '';
    return;
  }

  const currentLayer = ps?.current_layer ?? 0;
  const totalLayer = ps?.total_layer ?? state.fileTotalLayers ?? preview.layers.length;
  const zPos = s?.gcode_move?.z ?? 0;
  const progress = s?.machine_status?.progress ?? 0;

  if (isPrinting) {
    infoEl.textContent = `Layer ${currentLayer}/${totalLayer} · Z: ${zPos.toFixed(1)}mm · ${progress}%`;
  } else {
    infoEl.textContent = `${preview.layers.length} layers loaded`;
  }
}

/** Extract short filename from full path */
function shortName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

/** Bind control event handlers — call once at startup */
export function bindGcodePreviewControls(): void {
  // Layer slider
  const slider = $('gcode-layer-slider') as HTMLInputElement | null;
  if (slider) {
    slider.addEventListener('input', () => {
      if (!preview) return;
      followMode = false;
      const val = parseInt(slider.value, 10);
      preview.endLayer = val;
      lastEndLayer = val;
      preview.render();

      const followBtn = $('btn-gcode-follow');
      if (followBtn) followBtn.classList.remove('active');
    });
  }

  // Follow toggle button
  const followBtn = $('btn-gcode-follow');
  if (followBtn) {
    followBtn.addEventListener('click', () => {
      followMode = !followMode;
      followBtn.classList.toggle('active', followMode);
      if (followMode && preview) {
        // Jump to latest layer — if printing, the render loop will sync it
        preview.endLayer = preview.maxLayerIndex;
        preview.render();
      }
    });
  }

  // Load button
  const loadBtn = $('btn-load-gcode');
  if (loadBtn) {
    loadBtn.addEventListener('click', () => {
      const input = $('gcode-file-input') as HTMLInputElement | null;
      if (input) input.click();
    });
  }

  // Hidden file input for manual drag/load
  const fileInput = $('gcode-file-input') as HTMLInputElement | null;
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const gcode = reader.result as string;
        preview = initPreview();
        if (!preview) return;
        preview.processGCode(gcode);
        loadedFile = file.name;
        const slider = $('gcode-layer-slider') as HTMLInputElement | null;
        if (slider) {
          slider.max = String(preview.maxLayerIndex);
          slider.value = String(preview.maxLayerIndex);
        }
        const statusEl = $('gcode-preview-status');
        if (statusEl) statusEl.textContent = `${preview.layers.length} layers · ${file.name}`;
      };
      reader.readAsText(file);
      fileInput.value = '';
    });
  }

  // Handle canvas resize
  const canvas = $('gcode-preview-canvas') as HTMLCanvasElement | null;
  if (canvas) {
    const ro = new ResizeObserver(() => {
      if (preview) preview.resize();
    });
    ro.observe(canvas);
  }
}

/** Dispose the preview (if navigating away, cleanup) */
export function disposeGcodePreview(): void {
  if (preview) {
    try { preview.dispose(); } catch { /* ignore */ }
    preview = null;
  }
  loadedFile = '';
  lastEndLayer = -1;
}
