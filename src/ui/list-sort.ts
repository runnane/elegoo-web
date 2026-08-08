/**
 * List sorting and filtering — the pure half (ELEG-49).
 *
 * Deliberately free of DOM and localStorage so it can be unit-tested directly (the
 * vitest environment here is `node`, with no document). `ui/list-controls.ts` owns the
 * control bar, the storage and the event wiring; everything that decides *what the list
 * is* lives here.
 *
 * All four list views this serves sort **client-side over the full set**. That is not a
 * shortcut: files come back from 1044 in one shot, and history (1036) takes no paging
 * parameters at all, so there is no server-side ordering to reach for even if the sets
 * were large enough to want one.
 */

export type SortDirection = 'asc' | 'desc';

/** What a single sortable column extracts from a row. */
export interface SortColumn<T> {
  /** Stable identifier — persisted, so renaming one resets that view's saved sort. */
  key: string;
  /** Button label in the control bar. */
  label: string;
  /**
   * The value to order by. `undefined` sorts last in **both** directions, so a row
   * missing a timestamp does not lead the list just because you flipped to descending.
   */
  value: (item: T) => string | number | undefined;
  /** Direction applied when this column is first selected. Defaults to `'asc'`. */
  initialDirection?: SortDirection;
}

export interface SortState {
  key: string;
  dir: SortDirection;
}

/** A value with nothing to order by — `undefined`, or the empty string. */
function isMissing(value: string | number | undefined): boolean {
  return value === undefined || value === '';
}

/**
 * Order two extracted values. Strings compare with `localeCompare` (so `ä` lands where a
 * Norwegian reader expects), numbers numerically, and absent values always last.
 */
export function compareValues(
  a: string | number | undefined,
  b: string | number | undefined,
): number {
  if (isMissing(a) || isMissing(b)) {
    return isMissing(a) && isMissing(b) ? 0 : isMissing(a) ? 1 : -1;
  }
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

export interface SortOptions<T> {
  /**
   * A grouping rank applied *before* the column and **never** reversed by direction.
   * This is how Files keeps folders first no matter which column is sorted, or which
   * way — folders-first is a grouping rule, not a sort key.
   */
  group?: (item: T) => number;
}

/**
 * Sort a copy of `items` by `column` in `dir`.
 *
 * The tiebreak is `Array.prototype.sort`'s stability, which the spec has guaranteed
 * since ES2019: equal keys compare 0 and keep their arrival order, so a re-render
 * triggered by a WebSocket update does not reshuffle rows that tie.
 */
export function sortItems<T>(
  items: readonly T[],
  column: SortColumn<T> | undefined,
  dir: SortDirection,
  options: SortOptions<T> = {},
): T[] {
  const copy = [...items];
  const { group } = options;
  if (!column && !group) return copy;

  const sign = dir === 'desc' ? -1 : 1;
  return copy.sort((a, b) => {
    if (group) {
      const g = group(a) - group(b);
      if (g !== 0) return g;
    }
    if (!column) return 0;

    const av = column.value(a);
    const bv = column.value(b);
    // Missing-last is decided *before* the direction is applied, or flipping to
    // descending would drag every row with no value to the top — a file with no print
    // time leading the "longest print first" list is not what anyone asked for.
    if (isMissing(av) || isMissing(bv)) return compareValues(av, bv);

    return sign * compareValues(av, bv);
  });
}

/** Case-insensitive substring match. An empty or whitespace-only query matches everything. */
export function matchesQuery(query: string, text: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return text.toLowerCase().includes(needle);
}

/**
 * Keep the rows whose searchable text matches `query`. `text` may return several
 * strings per row (filename *and* job name, say) — a match in any of them keeps the row.
 */
export function filterItems<T>(
  items: readonly T[],
  query: string,
  text: (item: T) => string | readonly string[],
): T[] {
  if (!query.trim()) return [...items];
  return items.filter((item) => {
    const fields = text(item);
    const list = typeof fields === 'string' ? [fields] : fields;
    return list.some((field) => matchesQuery(query, field));
  });
}

/**
 * What clicking a column does: a different column adopts its own initial direction, the
 * same column toggles. Pure, so the control bar has no branching of its own.
 */
export function nextSortState<T>(current: SortState, column: SortColumn<T>): SortState {
  if (current.key !== column.key) {
    return { key: column.key, dir: column.initialDirection ?? 'asc' };
  }
  return { key: current.key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
}

/**
 * Turn whatever was in storage into a sort state that is safe to apply. A saved key for
 * a column that no longer exists falls back to the default rather than leaving the list
 * unsorted with a control bar that highlights nothing.
 */
export function normaliseSortState(
  parsed: unknown,
  validKeys: readonly string[],
  fallback: SortState,
): SortState {
  if (typeof parsed !== 'object' || parsed === null) return { ...fallback };
  const fields = parsed as Record<string, unknown>;
  const key = typeof fields.key === 'string' && validKeys.includes(fields.key) ? fields.key : null;
  if (!key) return { ...fallback };
  const dir = fields.dir === 'desc' ? 'desc' : 'asc';
  return { key, dir };
}

/**
 * Treat 0 as "no value" (ELEG-50).
 *
 * The printer sends `0` for a timestamp, size or duration it did not record, and 0 is a
 * perfectly good number — sorted as one it means 1970, which puts every unrecorded row
 * at the top of "newest first". Mapping it to `undefined` hands it to the missing-last
 * rule instead, where it belongs. Also catches NaN, which `Number()` on a bad field
 * produces and which silently poisons a comparator.
 */
export function nonZero(value: number | undefined): number | undefined {
  return value === undefined || value === 0 || Number.isNaN(value) ? undefined : value;
}

/**
 * The seconds between two epoch-second stamps, or `undefined` when either is missing or
 * the pair does not describe a finished job (a print still running has no end time, and
 * an end before its start is corrupt rather than negative-length).
 */
export function spanSeconds(
  begin: number | undefined,
  end: number | undefined,
): number | undefined {
  const from = nonZero(begin);
  const to = nonZero(end);
  if (from === undefined || to === undefined) return undefined;
  return to > from ? to - from : undefined;
}

/** The arrow shown on the active column's button. */
export function directionIndicator(dir: SortDirection): string {
  return dir === 'asc' ? '↑' : '↓';
}
