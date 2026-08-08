/**
 * Dashboard card layout — the pure half.
 *
 * Deliberately free of DOM and localStorage so it can be unit-tested directly (the
 * vitest environment here is `node`, with no document). `ui/settings.ts` owns the
 * storage and the rendering; everything that decides *what the layout is* lives here.
 */

export interface CardLayout {
  sidebar: string[];
  main: string[];
  hidden: string[];
  collapsed: string[];
}

/** Default sidebar cards (always-visible essentials) */
export const DEFAULT_SIDEBAR = [
  'temps-card',
  'canvas-card',
  'fans-card',
  'toolhead-card',
  'speed-flow-card',
];

/** Default main area cards (detail/reference) */
export const DEFAULT_MAIN = [
  'camera-card',
  'gcode-preview-card',
  'files-card',
  'print-history-card',
  'print-reports-card',
  'timelapse-card',
  'ai-card',
  'event-log-card',
  'log-card',
];

/** All known card IDs */
export const ALL_CARD_IDS = [...DEFAULT_SIDEBAR, ...DEFAULT_MAIN];

/** Human-readable names for cards */
export const CARD_NAMES: Record<string, string> = {
  'temps-card': '🌡️ Temperatures',
  'canvas-card': '🎨 Canvas / AMS',
  'camera-card': '📷 Camera',
  'ai-card': '🤖 AI Monitor',
  'event-log-card': '📜 Event Log',
  'gcode-preview-card': '📐 Layer Preview',
  'toolhead-card': '🎯 Toolhead',
  'fans-card': '🌀 Fans',
  'speed-flow-card': '⚡ Speed & Flow',
  'files-card': '📁 Files',
  'print-history-card': '📜 Print History',
  'print-reports-card': '📊 Print Reports',
  'timelapse-card': '🎬 Timelapse',
  'log-card': '📋 MQTT Log',
};

/** A fresh copy of the shipped layout. Fresh, because callers mutate what they get. */
export function defaultCardLayout(): CardLayout {
  return { sidebar: [...DEFAULT_SIDEBAR], main: [...DEFAULT_MAIN], hidden: [], collapsed: [] };
}

/** Strings only — a hand-edited or half-written layout should not poison the DOM pass. */
function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((v): v is string => typeof v === 'string');
}

/** Migrate the pre-panel format, `{ order, hidden }`, to sidebar + main. */
function migrateOldLayout(order: string[], hidden: string[]): CardLayout {
  const sidebar: string[] = [];
  const main: string[] = [];
  for (const id of order) {
    if (DEFAULT_SIDEBAR.includes(id)) sidebar.push(id);
    else main.push(id);
  }
  return { sidebar, main, hidden, collapsed: [] };
}

/**
 * Turn whatever was in storage into a layout that is safe to apply.
 *
 * Three jobs, and the third is the one with history behind it:
 *
 * 1. Defaults for anything absent, and non-strings dropped.
 * 2. The old `{ order, hidden }` format migrated.
 * 3. **Every known card placed.** A card added to the app after a user last saved
 *    their layout is in neither list, and before ELEG-44 this backfill lived in
 *    `applyCardLayout` — which mutated its in-memory copy but never saved it, while
 *    the settings panel re-read straight from storage. So the new card rendered on the
 *    dashboard but was missing from the settings list, and the next reorder saved a
 *    layout that still did not mention it. Doing it here means both paths see the same
 *    layout, because there is only one place that decides.
 *
 * A card named in both panels is kept only in the first (sidebar wins), so it cannot
 * appear twice in the settings list.
 */
export function normaliseCardLayout(parsed: unknown): CardLayout {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return defaultCardLayout();
  }
  const fields = parsed as Record<string, unknown>;

  const oldOrder = stringArray(fields.order);
  const layout = oldOrder
    ? migrateOldLayout(oldOrder, stringArray(fields.hidden) ?? [])
    : {
        sidebar: stringArray(fields.sidebar) ?? [...DEFAULT_SIDEBAR],
        main: stringArray(fields.main) ?? [...DEFAULT_MAIN],
        hidden: stringArray(fields.hidden) ?? [],
        collapsed: stringArray(fields.collapsed) ?? [],
      };

  const seen = new Set<string>();
  const firstOnly = (ids: string[]): string[] =>
    ids.filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  layout.sidebar = firstOnly(layout.sidebar);
  layout.main = firstOnly(layout.main);

  for (const id of ALL_CARD_IDS) {
    if (seen.has(id)) continue;
    (DEFAULT_SIDEBAR.includes(id) ? layout.sidebar : layout.main).push(id);
    seen.add(id);
  }

  return layout;
}
