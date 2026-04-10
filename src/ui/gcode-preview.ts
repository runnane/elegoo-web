/** Gcode preview — 3D toolpath visualization using gcode-preview library */

import { WebGLPreview } from 'gcode-preview';
import { ConeGeometry, MeshBasicMaterial, Mesh, EdgesGeometry, LineSegments, LineBasicMaterial, Group } from 'three';
import type { Object3D } from 'three';
import type { PrinterState } from '../printer-state';
import { $, fetchTimeout } from './helpers';

let preview: WebGLPreview | null = null;
let loadedFile = '';
let loading = false;
let lastEndLayer = -1;
let followMode = localStorage.getItem('gcode-follow') !== 'false';
let singleLayerMode = localStorage.getItem('gcode-single-layer') !== 'false';
/** Track last known printer file so we auto-load when print starts */
let lastPrinterFile = '';

/** Nozzle indicator mesh */
let nozzleMesh: Object3D | null = null;
/** Last applied filament color to avoid redundant updates */
let lastFilamentColor = '';
/** Cached color map for re-init */
let cachedColorMap: Array<{ t: number; color: string }> = [];

// CC2 Centauri Carbon 2 build volume (mm)
const BUILD_VOLUME = { x: 256, y: 256, z: 256, smallGrid: false };

/** Create the nozzle cone mesh with outline and add it to the scene */
function ensureNozzle(): void {
  if (nozzleMesh || !preview) return;
  const geo = new ConeGeometry(3, 8, 12);
  geo.rotateX(Math.PI);

  // Solid fill
  const mat = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
  const cone = new Mesh(geo, mat);

  // Dark outline for contrast
  const edges = new EdgesGeometry(geo);
  const lineMat = new LineBasicMaterial({ color: 0x000000, linewidth: 2 });
  const outline = new LineSegments(edges, lineMat);

  const group = new Group();
  group.name = 'nozzle-indicator';
  group.add(cone);
  group.add(outline);

  nozzleMesh = group;
  preview.scene.add(nozzleMesh);
}

/** Update nozzle position from printer state */
function updateNozzle(state: PrinterState): void {
  if (!preview) return;
  const gm = state.status?.gcode_move;
  const isPrinting = state.status?.machine_status?.status === 2;
  if (!gm || !isPrinting) {
    if (nozzleMesh) nozzleMesh.visible = false;
    return;
  }

  if (!nozzleMesh) {
    ensureNozzle();
    if (!nozzleMesh) return;
  }

  nozzleMesh.visible = true;
  // Group applies -PI/2 X rotation: gcode (x,y,z) → scene (x, z, -y)
  nozzleMesh.position.set(gm.x, gm.z + 4, -gm.y);
}

/** Build extrusionColor from colorMap — array for multi-color */
function buildExtrusionColors(colorMap: Array<{ t: number; color: string }>): string | string[] {
  if (colorMap.length === 0) return '#2196f3';
  if (colorMap.length === 1) return `#${colorMap[0].color.replace(/^#/, '')}`;
  // Multi-color: array indexed by tool number
  const maxTool = Math.max(...colorMap.map(c => c.t));
  const colors: string[] = new Array(maxTool + 1).fill('#888888');
  for (const entry of colorMap) {
    colors[entry.t] = `#${entry.color.replace(/^#/, '')}`;
  }
  return colors;
}

/** Re-init preview with updated colors if colorMap changed */
function updateFilamentColor(state: PrinterState): void {
  if (!preview || !loadedFile) return;
  const sig = state.colorMap.map(c => `${c.t}:${c.color}`).join(',');
  if (sig === lastFilamentColor || sig === '') return;
  lastFilamentColor = sig;
  cachedColorMap = state.colorMap;
  // Colors can only be set at construction, so re-load
  loadGcode(loadedFile);
}

/** Exported for main.ts to call on each render frame */
export function renderGcodePreview(state: PrinterState): void {
  const s = state.status;
  const ps = s?.print_status;
  const isPrinting = s?.machine_status?.status === 2;
  const filename = ps?.filename || '';

  // Auto-load when a new print starts (delay 3s to let printer settle)
  if (isPrinting && filename && filename !== lastPrinterFile) {
    lastPrinterFile = filename;
    cachedColorMap = state.colorMap;
    lastFilamentColor = state.colorMap.map(c => `${c.t}:${c.color}`).join(',');
    if (filename !== loadedFile) {
      setTimeout(() => loadGcode(filename), 3000);
    }
  }

  // When print stops, keep the preview but reset tracking
  if (!isPrinting && lastPrinterFile) {
    lastPrinterFile = '';
  }

  updateInfo(state);
  updateNozzle(state);
  updateFilamentColor(state);

  // Follow mode: update visible layers to match print progress
  if (!preview || !followMode) return;
  const currentLayer = ps?.current_layer ?? 0;
  if (isPrinting && currentLayer > 0 && currentLayer !== lastEndLayer) {
    lastEndLayer = currentLayer;
    preview.singleLayerMode = singleLayerMode;
    preview.endLayer = currentLayer;
    preview.render();

    // Sync slider
    const slider = $('gcode-layer-slider') as HTMLInputElement | null;
    if (slider) slider.value = String(currentLayer);
  } else if (isPrinting && nozzleMesh?.visible) {
    // Re-render to show updated nozzle position even if layer hasn't changed
    preview.render();
  }
}

/** Initialize the 3D preview on the canvas */
function initPreview(colorMap?: Array<{ t: number; color: string }>): WebGLPreview | null {
  const canvas = $('gcode-preview-canvas') as HTMLCanvasElement | null;
  if (!canvas) return null;

  // Dispose previous instance
  if (preview) {
    try { preview.dispose(); } catch { /* ignore */ }
    preview = null;
    nozzleMesh = null;
  }

  const extrusionColor = colorMap && colorMap.length > 0
    ? buildExtrusionColors(colorMap)
    : '#2196f3';

  const p = new WebGLPreview({
    canvas,
    backgroundColor: '#1e1e2e',
    extrusionColor,
    topLayerColor: '#00ffff',
    lastSegmentColor: '#ffffff',
    travelColor: '#444460',
    buildVolume: BUILD_VOLUME,
    lineWidth: 2,
    renderExtrusion: true,
    renderTravel: false,
    renderTubes: false,
    // Camera from front-right elevated — matches webcam perspective
    initialCameraPosition: [200, 350, 200],
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
    let resp: Response | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        resp = await fetchTimeout(url, undefined, 120_000);
        if (resp.ok) break;
        resp = null;
      } catch (e) {
        if (attempt < 3) {
          if (statusEl) statusEl.textContent = `Retry ${attempt}/2 — download failed`;
          await new Promise(r => setTimeout(r, 2000));
        } else {
          throw e;
        }
      }
    }
    if (!resp || !resp.ok) throw new Error(`Download failed: ${resp?.status ?? 'no response'}`);

    if (statusEl) statusEl.textContent = 'Parsing gcode…';

    const gcode = await resp.text();

    // Initialize clean preview with filament colors
    preview = initPreview(cachedColorMap);
    if (!preview) {
      if (statusEl) statusEl.textContent = 'Canvas not found';
      return;
    }

    // Process gcode (v3 is async)
    await preview.processGCode(gcode);
    loadedFile = filename;

    // Set layer slider range
    const totalLayers = preview.countLayers;
    const slider = $('gcode-layer-slider') as HTMLInputElement | null;
    if (slider) {
      slider.max = String(totalLayers);
      slider.value = String(totalLayers);
    }

    // Show total layers
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
  const totalLayer = ps?.total_layer ?? state.fileTotalLayers ?? preview.countLayers;
  const zPos = s?.gcode_move?.z ?? 0;
  const progress = s?.machine_status?.progress ?? 0;

  if (isPrinting) {
    infoEl.textContent = `Layer ${currentLayer}/${totalLayer} · Z: ${zPos.toFixed(1)}mm · ${progress}%`;
  } else {
    infoEl.textContent = `${preview.countLayers} layers loaded`;
  }
}

/** Extract short filename from full path */
function shortName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

/** Bind control event handlers — call once at startup */
export function bindGcodePreviewControls(): void {
  // Sync button states from persisted preferences
  const followBtnInit = $('btn-gcode-follow');
  if (followBtnInit) followBtnInit.classList.toggle('active', followMode);
  const singleBtnInit = $('btn-gcode-single-layer');
  if (singleBtnInit) singleBtnInit.classList.toggle('active', singleLayerMode);

  // Layer slider
  const slider = $('gcode-layer-slider') as HTMLInputElement | null;
  if (slider) {
    slider.addEventListener('input', () => {
      if (!preview) return;
      followMode = false;
      localStorage.setItem('gcode-follow', 'false');
      const val = parseInt(slider.value, 10);
      preview.endLayer = val;
      lastEndLayer = val;
      preview.render();

      const followBtn = $('btn-gcode-follow');
      if (followBtn) followBtn.classList.remove('active');

      if (preview) {
        preview.singleLayerMode = singleLayerMode;
        preview.render();
      }
    });
  }

  // Single layer toggle button
  const singleBtn = $('btn-gcode-single-layer');
  if (singleBtn) {
    singleBtn.addEventListener('click', () => {
      singleLayerMode = !singleLayerMode;
      localStorage.setItem('gcode-single-layer', String(singleLayerMode));
      singleBtn.classList.toggle('active', singleLayerMode);
      if (preview) {
        preview.singleLayerMode = singleLayerMode;
        preview.render();
      }
    });
  }

  // Follow toggle button
  const followBtn = $('btn-gcode-follow');
  if (followBtn) {
    followBtn.addEventListener('click', () => {
      followMode = !followMode;
      localStorage.setItem('gcode-follow', String(followMode));
      followBtn.classList.toggle('active', followMode);
      if (followMode && preview) {
        // Reset so the render loop picks up the current print layer
        lastEndLayer = -1;
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
      reader.onload = async () => {
        const gcode = reader.result as string;
        preview = initPreview(cachedColorMap);
        if (!preview) return;
        await preview.processGCode(gcode);
        loadedFile = file.name;
        const slider = $('gcode-layer-slider') as HTMLInputElement | null;
        if (slider) {
          slider.max = String(preview.countLayers);
          slider.value = String(preview.countLayers);
        }
        const statusEl = $('gcode-preview-status');
        if (statusEl) statusEl.textContent = `${preview.countLayers} layers · ${file.name}`;
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
    nozzleMesh = null;
  }
  loadedFile = '';
  lastEndLayer = -1;
}
