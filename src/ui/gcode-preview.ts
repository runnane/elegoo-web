/** Gcode preview — 3D toolpath visualization using gcode-preview library */

import { GCodePreview } from 'gcode-preview';
import type { SceneManager } from 'gcode-preview';
import {
  ConeGeometry,
  MeshBasicMaterial,
  Mesh,
  EdgesGeometry,
  LineSegments,
  LineBasicMaterial,
  Group,
} from 'three';
import type { Object3D } from 'three';
import type { PrinterState } from '../printer-state';
import { $, fetchTextTimeout } from './helpers';
import { chartPalette } from './chart-palette';
import { previewLayerOffset } from './gcode-layer-offset';

/**
 * Internal fields of the library's SceneManager we need to stop the animate loop.
 * Since gcode-preview 3.0.0-alpha.5 the loop lives on `preview.sceneManager`, not on
 * the preview object itself — aimed at the preview, this cast would silently do
 * nothing and the 60fps loop would be back (ELEG-120).
 */
interface SceneManagerInternals {
  animationFrameId?: number;
  animate: () => void;
}

/**
 * The library splits into GCodePreview (parsing, the job, `countLayers`) and its
 * `sceneManager` (scene, renderer, camera, controls, layer range, render/resize).
 * Never read `sceneManager` after `dispose()`: the getter lazily builds a fresh one,
 * with a new renderer and a new animate loop. Every caller here nulls `preview`
 * when it disposes it.
 */
let preview: GCodePreview | null = null;
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
  preview.sceneManager.scene.add(nozzleMesh);
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
  if (colorMap.length === 0) return chartPalette().gcodeExtrusion;
  if (colorMap.length === 1) return `#${colorMap[0].color.replace(/^#/, '')}`;
  // Multi-color: array indexed by tool number
  const maxTool = Math.max(...colorMap.map((c) => c.t));
  const colors: string[] = new Array(maxTool + 1).fill(chartPalette().gcodeUnknownTool);
  for (const entry of colorMap) {
    colors[entry.t] = `#${entry.color.replace(/^#/, '')}`;
  }
  return colors;
}

/** Re-init preview with updated colors if colorMap changed */
function updateFilamentColor(state: PrinterState): void {
  if (!preview || !loadedFile) return;
  const sig = state.colorMap.map((c) => `${c.t}:${c.color}`).join(',');
  if (sig === lastFilamentColor || sig === '') return;
  lastFilamentColor = sig;
  cachedColorMap = state.colorMap;
  // Colors can only be set at construction, so re-load
  loadGcode(loadedFile);
}

/** Throttle full gcode-preview renders (geometry rebuild) to max 2 FPS */
let lastRenderTime = 0;
const RENDER_INTERVAL = 500; // 2 FPS

function throttledRender(): void {
  const now = Date.now();
  if (now - lastRenderTime < RENDER_INTERVAL) return;
  lastRenderTime = now;
  preview?.sceneManager.render();
}

/** Lightweight WebGL-only redraw (no geometry rebuild) — for nozzle moves */
function lightRender(): void {
  const now = Date.now();
  if (now - lastRenderTime < RENDER_INTERVAL) return;
  lastRenderTime = now;
  if (!preview) return;
  redraw(preview.sceneManager);
}

/** One WebGL draw of the current scene, no geometry rebuild */
function redraw(sm: SceneManager): void {
  sm.renderer.render(sm.scene, sm.camera);
}

/** Stop the library's internal 60fps rAF animate loop */
function stopAnimateLoop(sm: SceneManager): void {
  // animationFrameId is private but accessible at runtime
  const internals = sm as unknown as SceneManagerInternals;
  const id = internals.animationFrameId;
  if (id != null) cancelAnimationFrame(id);
  // Override animate() so it can't restart
  internals.animate = () => {};
}

/** Render on orbit control changes (user dragging the 3D view) — throttled */
function onOrbitChange(): void {
  if (!preview) return;
  redraw(preview.sceneManager);
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
    lastFilamentColor = state.colorMap.map((c) => `${c.t}:${c.color}`).join(',');
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
    preview.sceneManager.singleLayerMode = singleLayerMode;
    // Without slicer layer comments the preamble is a preview layer of its own, so
    // printer layer N is preview layer N+1; with them it is N (see gcode-layer-offset).
    const offset = previewLayerOffset(
      preview.countLayers,
      ps?.total_layer ?? state.fileTotalLayers,
      Boolean(preview.parser.metadata.slicerName),
    );
    const previewLayer = currentLayer + offset;
    preview.sceneManager.endLayer = previewLayer;
    throttledRender();

    // Sync slider (it is in preview layers, like endLayer)
    const slider = $('gcode-layer-slider') as HTMLInputElement | null;
    if (slider) slider.value = String(previewLayer);
  } else if (isPrinting && nozzleMesh?.visible) {
    // Re-render to show updated nozzle position (lightweight, no geometry rebuild)
    lightRender();
  }
}

/** Initialize the 3D preview on the canvas */
function initPreview(colorMap?: Array<{ t: number; color: string }>): GCodePreview | null {
  const pal = chartPalette();
  const canvas = $('gcode-preview-canvas') as HTMLCanvasElement | null;
  if (!canvas) return null;

  // Dispose previous instance
  if (preview) {
    try {
      preview.dispose();
    } catch {
      /* ignore */
    }
    preview = null;
    nozzleMesh = null;
  }

  const extrusionColor =
    colorMap && colorMap.length > 0 ? buildExtrusionColors(colorMap) : pal.gcodeExtrusion;

  const p = new GCodePreview({
    canvas,
    backgroundColor: pal.gcodeBg,
    extrusionColor,
    topLayerColor: pal.gcodeTopLayer,
    lastSegmentColor: pal.gcodeLastSegment,
    travelColor: pal.gcodeTravel,
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
    let gcode: string | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        // The bound covers the body too, not just the headers (ELEG-131).
        const got = await fetchTextTimeout(url, undefined, 120_000);
        if (got.bodyError) {
          // Headers arrived, then the printer stalled or dropped the file. Retrying
          // would only wait out the bound again, so report it straight away.
          throw new Error(
            'The printer did not deliver the file (the download stalled or was cut off). ' +
              'It may refuse file downloads while printing — try again when the print has finished.',
          );
        }
        resp = got.resp;
        if (resp.ok) {
          gcode = got.text;
          break;
        }
        resp = null;
      } catch (e) {
        if ((e as Error).message.startsWith('The printer did not deliver')) throw e;
        if (attempt < 3) {
          if (statusEl) statusEl.textContent = `Retry ${attempt}/2 — download failed`;
          await new Promise((r) => setTimeout(r, 2000));
        } else {
          throw e;
        }
      }
    }
    if (!resp || !resp.ok) throw new Error(`Download failed: ${resp?.status ?? 'no response'}`);

    if (gcode === null) throw new Error('Download failed: empty response');

    if (statusEl) statusEl.textContent = 'Parsing gcode…';

    // Initialize clean preview with filament colors
    preview = initPreview(cachedColorMap);
    if (!preview) {
      if (statusEl) statusEl.textContent = 'Canvas not found';
      return;
    }

    // Process gcode (v3 is async)
    await preview.processGCode(gcode);

    // Stop the library's built-in 60fps animate loop — it calls WebGL render()
    // every frame, leaking ~23 MB/s. We render on-demand instead.
    stopAnimateLoop(preview.sceneManager);
    // Re-render once after stopping the loop (processGCode's last frame may be lost)
    redraw(preview.sceneManager);
    // Render on orbit control interaction (user dragging)
    preview.sceneManager.controls.addEventListener('change', onOrbitChange);

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
  const displayedLayer = preview.sceneManager.endLayer ?? preview.countLayers;

  if (isPrinting) {
    const layerLabel = singleLayerMode ? `Showing ${displayedLayer}` : `Layer ${currentLayer}`;
    infoEl.textContent = `${layerLabel}/${totalLayer} · Z: ${zPos.toFixed(1)}mm · ${progress}%`;
  } else {
    infoEl.textContent = `Layer ${displayedLayer}/${preview.countLayers}`;
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
      localStorage.setItem('gcode-follow', 'false');
      const val = parseInt(slider.value, 10);
      preview.sceneManager.endLayer = val;
      lastEndLayer = val;
      preview.sceneManager.render();

      const followBtn = $('btn-gcode-follow');
      if (followBtn) followBtn.classList.remove('active');

      if (preview) {
        preview.sceneManager.singleLayerMode = singleLayerMode;
        preview.sceneManager.render();
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
        preview.sceneManager.singleLayerMode = singleLayerMode;
        preview.sceneManager.render();
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
      if (preview) preview.sceneManager.resize();
    });
    ro.observe(canvas);
  }
}

/** Dispose the preview (if navigating away, cleanup) */
export function disposeGcodePreview(): void {
  if (preview) {
    try {
      preview.dispose();
    } catch {
      /* ignore */
    }
    preview = null;
    nozzleMesh = null;
  }
  loadedFile = '';
  lastEndLayer = -1;
}
