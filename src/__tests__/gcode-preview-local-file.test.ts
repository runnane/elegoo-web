// @vitest-environment jsdom
/**
 * ELEG-151: a gcode file picked through the hidden `gcode-file-input` must go through
 * the same post-`processGCode` steps as a download — above all, stopping the library's
 * 60fps animate loop (the one `.github/lessons-learned.md` measured leaking ~23 MB/s).
 *
 * The real `bindGcodePreviewControls()` handler runs; only `gcode-preview` is mocked, with
 * a scene manager whose `animationFrameId` / `animate` / `controls` / `renderer` we can
 * observe. This proves the wiring, not the rendering — the receiver-side rAF count is the
 * recipe in `.agents/testing.md`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const makeSceneManager = () => ({
    animationFrameId: 42,
    animate: () => 'library-animate',
    controls: { addEventListener: vi.fn() },
    renderer: { render: vi.fn() },
    scene: {},
    camera: {},
    resize: vi.fn(),
  });
  type SM = ReturnType<typeof makeSceneManager>;
  const instances: Array<{ sceneManager: SM; countLayers: number; originalAnimate: () => string }> =
    [];
  class FakeGCodePreview {
    sceneManager = makeSceneManager();
    originalAnimate = this.sceneManager.animate;
    countLayers = 7;
    constructor() {
      instances.push(this);
    }
    async processGCode(): Promise<void> {}
    dispose(): void {}
  }
  return { instances, FakeGCodePreview };
});

vi.mock('gcode-preview', () => ({ GCodePreview: h.FakeGCodePreview }));

import { bindGcodePreviewControls } from '../ui/gcode-preview';

describe('gcode file input (ELEG-151)', () => {
  beforeEach(() => {
    h.instances.length = 0;
    document.body.innerHTML = `
      <canvas id="gcode-preview-canvas"></canvas>
      <div id="gcode-preview-status"></div>
      <div id="gcode-preview-info"></div>
      <input id="gcode-layer-slider" type="range" />
      <input id="gcode-file-input" type="file" />`;
  });

  it('stops the library animate loop for a locally loaded file', async () => {
    const cancel = vi.fn();
    vi.stubGlobal('cancelAnimationFrame', cancel);
    // jsdom has no ResizeObserver; bindGcodePreviewControls observes the canvas.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
      },
    );
    bindGcodePreviewControls();

    const input = document.getElementById('gcode-file-input') as HTMLInputElement;
    const file = new File(['G1 X1 Y1\n'], 'local-benchy.gcode', { type: 'text/plain' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));

    const status = document.getElementById('gcode-preview-status') as HTMLElement;
    await vi.waitFor(() => expect(status.textContent).toBe('7 layers · local-benchy.gcode'));

    expect(h.instances).toHaveLength(1);
    const sm = h.instances[0].sceneManager;
    // The pending animation frame was cancelled and animate() can no longer restart it.
    expect(cancel).toHaveBeenCalledWith(42);
    expect(sm.animate).not.toBe(h.instances[0].originalAnimate);
    expect(sm.animate()).toBeUndefined();
    // The one on-demand redraw and the orbit listener the download path also does.
    expect(sm.renderer.render).toHaveBeenCalledTimes(1);
    expect(sm.controls.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));
    // Slider range follows the layer count.
    const slider = document.getElementById('gcode-layer-slider') as HTMLInputElement;
    expect(slider.max).toBe('7');
    expect(slider.value).toBe('7');
  });
});
