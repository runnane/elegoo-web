/**
 * The canvas charts' colours, read from the stylesheet (ELEG-34).
 *
 * `layer-chart.ts`, `charts.ts` and the gcode preview draw to a `<canvas>`, where CSS
 * does not reach. They used to hardcode `#a0a0b8`, `rgba(160,160,184,0.12)`, `#ab47bc`
 * and friends — which is exactly why they would have stayed dark-on-dark while the rest
 * of the UI flipped to light, and a half-themed dashboard is worse than a dark one.
 *
 * So the values live in `:root` / `:root[data-theme='light']` as custom properties and
 * are read back here with `getComputedStyle`. One definition per colour, both themes.
 *
 * ## Cached, and invalidated on theme change
 *
 * `getComputedStyle` forces style resolution, and these are read inside draw loops that
 * run per frame. The palette can only change when the theme does, so it is resolved
 * once and `invalidateChartPalette()` clears it.
 *
 * ## Falls back rather than throwing
 *
 * There is no DOM under vitest (`environment: "node"`), and the render test in
 * `src/__tests__/layer-chart-render.test.ts` stubs `document` with nothing but
 * `getElementById`. Every lookup therefore degrades to the dark value, which keeps the
 * charts drawable in any environment and keeps that test meaningful.
 */

export interface ChartPalette {
  grid: string;
  label: string;
  series: string;
  seriesFill: string;
  seriesLine: string;
  seriesPoint: string;
  crosshair: string;
  tooltipBg: string;
  tooltipBorder: string;
  tooltipText: string;
  aboveAvg: string;
  belowAvg: string;
  tempFill: string;
  gcodeBg: string;
  gcodeExtrusion: string;
  gcodeTravel: string;
  gcodeTopLayer: string;
  gcodeLastSegment: string;
  gcodeUnknownTool: string;
}

/** CSS custom property backing each field. */
const VARS: Record<keyof ChartPalette, string> = {
  grid: '--chart-grid',
  label: '--chart-label',
  series: '--chart-series',
  seriesFill: '--chart-series-fill',
  seriesLine: '--chart-series-line',
  seriesPoint: '--chart-series-point',
  crosshair: '--chart-crosshair',
  tooltipBg: '--chart-tooltip-bg',
  tooltipBorder: '--chart-tooltip-border',
  tooltipText: '--chart-tooltip-text',
  aboveAvg: '--chart-above-avg',
  belowAvg: '--chart-below-avg',
  tempFill: '--chart-temp-fill',
  gcodeBg: '--gcode-bg',
  gcodeExtrusion: '--gcode-extrusion',
  gcodeTravel: '--gcode-travel',
  gcodeTopLayer: '--gcode-top-layer',
  gcodeLastSegment: '--gcode-last-segment',
  gcodeUnknownTool: '--gcode-unknown-tool',
};

/**
 * The dark values, byte-identical to the literals they replaced.
 *
 * Used whenever the stylesheet cannot be read. Keeping them equal to the old hardcoded
 * set means a failure to resolve looks exactly like the pre-ELEG-34 behaviour rather
 * than like a new bug.
 */
export const FALLBACK_PALETTE: ChartPalette = {
  grid: 'rgba(160, 160, 184, 0.12)',
  label: '#a0a0b8',
  series: '#ab47bc',
  seriesFill: 'rgba(171, 71, 188, 0.12)',
  seriesLine: 'rgba(171, 71, 188, 0.4)',
  seriesPoint: 'rgba(171, 71, 188, 0.5)',
  crosshair: 'rgba(255, 255, 255, 0.25)',
  tooltipBg: 'rgba(30, 30, 44, 0.92)',
  tooltipBorder: 'rgba(255, 255, 255, 0.15)',
  tooltipText: '#e0e0e8',
  aboveAvg: '#ef5350',
  belowAvg: '#66bb6a',
  tempFill: 'rgba(33, 150, 243, 0.3)',
  gcodeBg: '#1e1e2e',
  gcodeExtrusion: '#2196f3',
  gcodeTravel: '#444460',
  gcodeTopLayer: '#00ffff',
  gcodeLastSegment: '#ffffff',
  gcodeUnknownTool: '#888888',
};

let cached: ChartPalette | null = null;

/**
 * Resolve the palette from the stylesheet.
 *
 * Exported for tests: it takes the resolver rather than reaching for the global, so the
 * light and dark cases can be exercised without a browser.
 */
export function resolvePalette(readVar: (name: string) => string | undefined): ChartPalette {
  const out = {} as ChartPalette;
  for (const key of Object.keys(VARS) as (keyof ChartPalette)[]) {
    const value = readVar(VARS[key])?.trim();
    // An empty string is what getPropertyValue returns for an undefined property, so it
    // has to fall back rather than be assigned — `fillStyle = ''` silently keeps the
    // previous colour, which would be a genuinely confusing bug to chase.
    out[key] = value ? value : FALLBACK_PALETTE[key];
  }
  return out;
}

/** The current palette. Resolved once; call `invalidateChartPalette` on theme change. */
export function chartPalette(): ChartPalette {
  if (cached) return cached;
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') {
    // No DOM — under vitest, or the render-test stub. Do not cache: a real document may
    // exist by the next call in a browser.
    return FALLBACK_PALETTE;
  }
  const style = getComputedStyle(document.documentElement);
  cached = resolvePalette((name) => style.getPropertyValue(name));
  return cached;
}

/** Drop the cached palette. Call whenever the theme changes. */
export function invalidateChartPalette(): void {
  cached = null;
}
