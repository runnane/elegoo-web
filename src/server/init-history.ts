/**
 * Bounding the chart history a WebSocket `init` frame carries (ELEG-194).
 *
 * The store keeps up to 300,000 chart points and 300,000 AI chart points (~83 h at 1 Hz)
 * and restores them from `state.json`. Sent whole, that is ~100 MB of JSON, and
 * `WebSocketTransport.broadcast()` drops any client with more than 32 MiB queued — so a
 * fresh browser was dropped by the next 1 Hz `chart_data`, reconnected, got the same
 * `init`, and never got past "Connecting to the service…".
 *
 * What the browser can actually show decides the bound:
 * - The charts' longest preset window is 1 h (`index.html`, `data-window="3600"`) and
 *   wheel zoom-out stops at 0.1x (`src/ui/charts.ts`), so at most 10 h is on screen at
 *   once; pan reaches further back. The newest {@link INIT_CHART_FULL_RES_POINTS} points
 *   (one hour at the store's 1 Hz sampler) go at full resolution; everything older is
 *   decimated evenly into the rest of {@link INIT_CHART_MAX_POINTS}. For a full store
 *   that is a point every ~18 s, finer than one pixel at the 10 h zoom-out.
 * - The browser feeds AI points through `ChartStore.pushPoint`, which keeps only the
 *   last 3,600 per series. Anything older is thrown away on arrival, so a plain tail of
 *   {@link INIT_AI_CHART_MAX_POINTS} loses nothing.
 *
 * Point counts alone depend on how big a point is, so {@link boundInitHistory} also
 * measures the result and halves the budgets until both histories fit in
 * {@link INIT_HISTORY_MAX_BYTES}. The stored history is never modified: persistence and
 * the REST, MCP and compat readers still see all of it.
 */

/** Chart points an `init` carries at most */
export const INIT_CHART_MAX_POINTS = 20_000;
/** The newest chart points sent at full resolution: one hour at 1 Hz */
export const INIT_CHART_FULL_RES_POINTS = 3_600;
/** AI chart points an `init` carries at most: what the browser's ChartStore keeps */
export const INIT_AI_CHART_MAX_POINTS = 3_600;
/** Serialized bytes both histories together may take; `MAX_BACKLOG` is 32 MiB */
export const INIT_HISTORY_MAX_BYTES = 8 * 1024 * 1024;

/**
 * At most `maxPoints` of `points`, in their original order: the newest `fullResPoints`
 * untouched, and the older ones decimated evenly into what is left of the budget (the
 * oldest point is always kept, so the time span is preserved). A history that already
 * fits is returned as is.
 */
export function boundHistory<T>(
  points: readonly T[],
  maxPoints: number,
  fullResPoints: number,
): readonly T[] {
  const max = Math.max(1, Math.floor(maxPoints));
  if (points.length <= max) return points;
  const recent = Math.min(Math.max(0, Math.floor(fullResPoints)), max);
  const olderBudget = max - recent;
  const olderCount = points.length - recent;
  const out: T[] = [];
  // olderCount > olderBudget here, so these indices are strictly increasing.
  for (let i = 0; i < olderBudget; i++) {
    out.push(points[Math.floor((i * olderCount) / olderBudget)]);
  }
  for (let i = olderCount; i < points.length; i++) out.push(points[i]);
  return out;
}

export interface InitHistory<C, A> {
  chartHistory: readonly C[];
  aiChartHistory: readonly A[];
}

/**
 * The chart and AI chart history for one `init` frame: bounded by point count, then
 * shrunk by halving until the two serialize to no more than `maxBytes` together. The
 * newest point of each is always kept; a pathological point that alone exceeds the
 * budget leaves one point each rather than looping.
 */
export function boundInitHistory<C, A>(
  chart: readonly C[],
  ai: readonly A[],
  maxBytes: number = INIT_HISTORY_MAX_BYTES,
): InitHistory<C, A> {
  let chartMax = INIT_CHART_MAX_POINTS;
  let fullRes = INIT_CHART_FULL_RES_POINTS;
  let aiMax = INIT_AI_CHART_MAX_POINTS;
  for (;;) {
    const result = {
      chartHistory: boundHistory(chart, chartMax, fullRes),
      aiChartHistory: boundHistory(ai, aiMax, aiMax),
    };
    if (chartMax <= 1 && aiMax <= 1) return result;
    if (Buffer.byteLength(JSON.stringify(result)) <= maxBytes) return result;
    chartMax = Math.max(1, Math.floor(chartMax / 2));
    // Never below 1: a zero tail would keep the oldest point instead of the newest.
    fullRes = Math.max(1, Math.floor(fullRes / 2));
    aiMax = Math.max(1, Math.floor(aiMax / 2));
  }
}
