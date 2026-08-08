/**
 * List control bar — the DOM half of the shared sort/filter helper (ELEG-49).
 *
 * The pure decisions live in `list-sort.ts`; this owns the markup, the events and the
 * persistence. Adopted by Files, Print History, Print Reports and Timelapse.
 *
 * **The control bar is mounted once and never re-rendered wholesale.** That is the whole
 * design, and it is what makes the trap ELEG-22 names impossible here: these views
 * re-render on every WebSocket message, so a filter input rebuilt as part of the render
 * would lose focus and selection under anyone typing while a 1036 response lands. The
 * bar therefore lives in a *static* container that is a sibling of the list, sort/filter
 * state lives in this closure rather than in the render function, and the only thing a
 * re-render touches is the list itself. Clicking a sort button repaints the buttons
 * alone — never the input.
 */

import {
  type SortColumn,
  type SortDirection,
  type SortState,
  directionIndicator,
  filterItems,
  nextSortState,
  normaliseSortState,
  sortItems,
} from './list-sort';
import { escapeAttr, escapeHtml } from './helpers';
import { getListSelect, getListSort, saveListSelect, saveListSort } from './ui-settings';

/** A dropdown filter, e.g. Print History's completed / failed / stopped. */
export interface SelectFilter<T> {
  /** Stable id — persisted under the view's key. */
  id: string;
  label: string;
  /** `all` is supplied automatically as the first option and means "no filtering". */
  options: ReadonlyArray<{ value: string; label: string }>;
  /** Called only when the selection is not `all`. */
  match: (item: T, value: string) => boolean;
}

export interface ListControlsOptions<T> {
  /** Stable id for this view — the persistence key and the DOM id prefix. */
  id: string;
  /** A **static** element that the render pass never overwrites. */
  container: HTMLElement;
  columns: ReadonlyArray<SortColumn<T>>;
  defaultSort: SortState;
  /** Searchable text per row; a match in any returned string keeps the row. */
  filterText: (item: T) => string | readonly string[];
  filterPlaceholder?: string;
  selects?: ReadonlyArray<SelectFilter<T>>;
  /** Grouping rank applied before the sort column and never reversed (folders first). */
  group?: (item: T) => number;
  /** The view re-renders itself from its own state; this just says "something changed". */
  onChange: () => void;
  /** Noun for the count readout, e.g. `files`. Defaults to `items`. */
  noun?: string;
}

export interface ListControls<T> {
  /** Filter, then sort. Also updates the "n of m" readout. */
  apply(items: readonly T[]): T[];
  /** True when a text query or a non-`all` dropdown is narrowing the list. */
  isFiltering(): boolean;
  /**
   * The empty-state HTML to show for an empty *result*. A filtered-to-nothing list says
   * "narrow your filter"; an empty source list says the caller's own message, which is a
   * different fact and needs different words.
   */
  emptyHtml(noDataMessage: string): string;
}

/** Debounced, because Files kicks off thumbnail and cache fetches on every render. */
const FILTER_DEBOUNCE_MS = 150;

export function createListControls<T>(options: ListControlsOptions<T>): ListControls<T> {
  const { id, container, columns, filterText, group, onChange } = options;
  const keys = columns.map((c) => c.key);

  let sort: SortState = normaliseSortState(getListSort(id), keys, options.defaultSort);
  let query = '';
  const selectValues = new Map<string, string>();
  for (const select of options.selects ?? []) {
    selectValues.set(select.id, getListSelect(`${id}.${select.id}`) ?? 'all');
  }

  container.classList.add('list-controls');
  container.innerHTML = `
    <input type="search" class="list-filter" id="${escapeAttr(id)}-filter"
           placeholder="${escapeAttr(options.filterPlaceholder ?? 'Filter…')}"
           aria-label="${escapeAttr(options.filterPlaceholder ?? 'Filter list')}">
    ${(options.selects ?? [])
      .map(
        (select) => `<select class="list-select" id="${escapeAttr(`${id}-${select.id}`)}"
             aria-label="${escapeAttr(select.label)}">
        <option value="all">${escapeHtml(select.label)}: all</option>
        ${select.options
          .map(
            (opt) =>
              `<option value="${escapeAttr(opt.value)}">${escapeHtml(select.label)}: ${escapeHtml(opt.label)}</option>`,
          )
          .join('')}
      </select>`,
      )
      .join('')}
    <div class="list-sort" role="group" aria-label="Sort by"></div>
    <span class="list-count" aria-live="polite"></span>`;

  const filterInput = container.querySelector('.list-filter') as HTMLInputElement;
  const sortWrap = container.querySelector('.list-sort') as HTMLElement;
  const countEl = container.querySelector('.list-count') as HTMLElement;

  /** Repaints the sort buttons only — deliberately not the input above them. */
  function renderSortButtons(): void {
    sortWrap.innerHTML = columns
      .map((column) => {
        const active = column.key === sort.key;
        const arrow = active ? ` ${directionIndicator(sort.dir)}` : '';
        return `<button type="button" class="list-sort-btn${active ? ' active' : ''}"
          data-key="${escapeAttr(column.key)}"
          aria-pressed="${active}"
          title="Sort by ${escapeAttr(column.label)}">${escapeHtml(column.label)}${arrow}</button>`;
      })
      .join('');
  }

  renderSortButtons();

  for (const select of options.selects ?? []) {
    const el = container.querySelector(`#${CSS.escape(`${id}-${select.id}`)}`) as HTMLSelectElement;
    el.value = selectValues.get(select.id) ?? 'all';
    el.addEventListener('change', () => {
      selectValues.set(select.id, el.value);
      saveListSelect(`${id}.${select.id}`, el.value);
      onChange();
    });
  }

  sortWrap.addEventListener('click', (event) => {
    const btn = (event.target as HTMLElement).closest('.list-sort-btn') as HTMLElement | null;
    if (!btn) return;
    const column = columns.find((c) => c.key === btn.dataset.key);
    if (!column) return;
    sort = nextSortState(sort, column);
    saveListSort(id, sort);
    renderSortButtons();
    onChange();
  });

  let debounce: ReturnType<typeof setTimeout> | null = null;
  filterInput.addEventListener('input', () => {
    query = filterInput.value;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(onChange, FILTER_DEBOUNCE_MS);
  });

  function activeSelects(): Array<{ select: SelectFilter<T>; value: string }> {
    return (options.selects ?? [])
      .map((select) => ({ select, value: selectValues.get(select.id) ?? 'all' }))
      .filter((entry) => entry.value !== 'all');
  }

  function isFiltering(): boolean {
    return query.trim() !== '' || activeSelects().length > 0;
  }

  return {
    apply(items) {
      let result = filterItems(items, query, filterText);
      for (const { select, value } of activeSelects()) {
        result = result.filter((item) => select.match(item, value));
      }
      const column = columns.find((c) => c.key === sort.key);
      result = sortItems(result, column, sort.dir, { group });

      const noun = options.noun ?? 'items';
      countEl.textContent =
        items.length === 0
          ? ''
          : isFiltering()
            ? `${result.length} of ${items.length} ${noun}`
            : `${items.length} ${noun}`;
      return result;
    },
    isFiltering,
    emptyHtml(noDataMessage) {
      return isFiltering()
        ? '<div class="file-empty">Nothing matches your filter. Clear it or try a shorter search.</div>'
        : `<div class="file-empty">${noDataMessage}</div>`;
    },
  };
}

export type { SortColumn, SortDirection, SortState };
