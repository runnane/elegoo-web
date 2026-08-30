// @vitest-environment jsdom
/**
 * The first DOM tests in this repo (ELEG-61).
 *
 * Everything else runs in vitest's default `node` environment, which is faster and is
 * where the pure halves belong — `list-sort.ts`, `card-layout.ts`, `layer-chart.ts`. The
 * docblock above opts THIS FILE ALONE into jsdom, which is why there is no config change
 * anywhere: no `environment` key, no glob, nothing for the next person to discover.
 * Copy the docblock, not a config entry.
 *
 * What is under test is the one invariant `list-controls.ts` is built around and that
 * ELEG-22 called out as most likely to be got wrong and least likely to be caught:
 *
 *   the control bar is mounted once into a STATIC container that is a sibling of the
 *   list, so re-rendering the list never rebuilds the filter input, and typing survives
 *   a WebSocket update landing mid-keystroke.
 *
 * These views assign `container.innerHTML` wholesale on every 1036 response. If the bar
 * were built inside that container, an input would be destroyed and recreated under
 * whoever was typing — losing focus, the caret and any selection.
 *
 * NOTE ON THE FAILING DIRECTION. A test that cannot go red is not coverage, so the
 * counterfactual is encoded here permanently rather than demonstrated once by hand and
 * described in a commit message: `describe('the failure mode ...')` mounts the bar INSIDE
 * the re-rendered container and asserts that focus IS lost. If someone "simplifies"
 * list-controls into the list container, the sibling tests go red — and if someone
 * weakens these assertions so they pass either way, the counterfactual test goes red
 * instead, because it would then be asserting a failure that no longer happens.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createListControls } from '../ui/list-controls';

interface Row {
  name: string;
  size: number;
  state: string;
}

const ROWS: Row[] = [
  { name: 'benchy.gcode', size: 300, state: 'done' },
  { name: 'calibration-cube.gcode', size: 100, state: 'failed' },
  { name: 'vase.gcode', size: 200, state: 'done' },
];

const COLUMNS = [
  { key: 'name', label: 'Name', value: (r: Row) => r.name },
  { key: 'size', label: 'Size', value: (r: Row) => r.size },
] as const;

/**
 * Unique per test. Two independent reasons, both worth knowing before writing more of
 * these:
 *
 *  1. `ui-settings.ts` memoises the whole settings object in a module-level `cached`, so
 *     clearing storage between tests would not reset it — a persisted sort from one test
 *     would leak into the next.
 *  2. There **used** to be no `localStorage` in this environment at all, so a test that
 *     appeared to assert persistence was vacuous. **ELEG-64 fixed that** — a setup file
 *     now installs one, and `ui-settings-persistence.test.ts` asserts real round-trips.
 *     Reason 1 above still stands entirely on its own, which is why unique ids remain
 *     the right approach here.
 *
 *     If you do write a persistence test, follow that file: never assert a value equal
 *     to the module's default, because `ui-settings.ts` still wraps every access in
 *     try/catch and still degrades silently to defaults. The environment is fixed; the
 *     way such a test can pass for the wrong reason is not.
 *
 * Distinct ids sidestep both, and are cheaper and less brittle than resetting modules.
 */
let seq = 0;
const nextId = () => `test-list-${++seq}`;

/** The real shape from index.html: a static controls div beside the re-rendered list. */
function mountSiblingLayout() {
  document.body.innerHTML = `<div id="controls"></div><div id="list"></div>`;
  return {
    controls: document.querySelector('#controls') as HTMLElement,
    list: document.querySelector('#list') as HTMLElement,
  };
}

/** What every one of these views does on a WebSocket update. */
function renderList(list: HTMLElement, rows: readonly Row[]) {
  list.innerHTML = rows.map((r) => `<div class="row">${r.name}</div>`).join('');
}

function makeControls(container: HTMLElement, id: string, onChange = () => {}) {
  return createListControls<Row>({
    id,
    container,
    columns: [...COLUMNS],
    defaultSort: { key: 'name', dir: 'asc' },
    filterText: (r) => r.name,
    noun: 'files',
    onChange,
    selects: [
      {
        id: 'state',
        label: 'State',
        options: [
          { value: 'done', label: 'Done' },
          { value: 'failed', label: 'Failed' },
        ],
        match: (r, v) => r.state === v,
      },
    ],
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('the focus invariant', () => {
  it('keeps focus, caret and selection through a list re-render', () => {
    const { controls, list } = mountSiblingLayout();
    const api = makeControls(controls, nextId());
    renderList(list, api.apply(ROWS));

    const input = controls.querySelector('.list-filter') as HTMLInputElement;
    input.focus();
    input.value = 'calibration';
    input.setSelectionRange(4, 9); // mid-word selection, the fragile case

    expect(document.activeElement).toBe(input);

    // A 1036 response lands mid-keystroke.
    renderList(list, ROWS);

    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('calibration');
    expect(input.selectionStart).toBe(4);
    expect(input.selectionEnd).toBe(9);
    // Same node, not a rebuilt one that merely looks the same.
    expect(controls.querySelector('.list-filter')).toBe(input);
  });

  it('survives many re-renders, as a burst of updates would cause', () => {
    const { controls, list } = mountSiblingLayout();
    makeControls(controls, nextId());

    const input = controls.querySelector('.list-filter') as HTMLInputElement;
    input.focus();
    input.value = 'vase';

    for (let i = 0; i < 25; i++) renderList(list, ROWS);

    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('vase');
  });

  it('repaints only the sort buttons when one is clicked, never the input', () => {
    const { controls } = mountSiblingLayout();
    makeControls(controls, nextId());

    const input = controls.querySelector('.list-filter') as HTMLInputElement;
    const sortWrap = controls.querySelector('.list-sort') as HTMLElement;
    input.focus();
    input.value = 'ben';
    input.setSelectionRange(3, 3);

    const sizeBtn = sortWrap.querySelector('[data-key="size"]') as HTMLButtonElement;
    sizeBtn.click();

    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('ben');
    expect(input.selectionStart).toBe(3);
    expect(controls.querySelector('.list-filter')).toBe(input);

    // The buttons themselves DID repaint — otherwise this test would pass on a
    // control bar that simply never updates, which is not the invariant.
    expect(sortWrap.querySelector('[data-key="size"]')).not.toBe(sizeBtn);
    expect(
      (sortWrap.querySelector('[data-key="size"]') as HTMLElement).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('keeps focus when a dropdown filter changes', () => {
    const { controls, list } = mountSiblingLayout();
    const api = makeControls(controls, nextId(), () => renderList(list, api.apply(ROWS)));

    const input = controls.querySelector('.list-filter') as HTMLInputElement;
    const select = controls.querySelector('.list-select') as HTMLSelectElement;
    input.focus();
    input.value = 'a';

    select.value = 'failed';
    select.dispatchEvent(new Event('change'));

    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('a');
  });
});

describe('the failure mode the sibling layout prevents', () => {
  /**
   * Deliberately WRONG: the control bar is mounted inside the container the render pass
   * overwrites. This asserts the bug is real, which is what makes the tests above
   * meaningful — if this ever passes, `renderList` has stopped destroying its children
   * and the sibling requirement no longer has teeth.
   */
  it('loses focus and the caret when the bar is inside the re-rendered container', () => {
    document.body.innerHTML = `<div id="list"></div>`;
    const list = document.querySelector('#list') as HTMLElement;

    const bar = document.createElement('div');
    list.appendChild(bar); // <- the mistake
    makeControls(bar, nextId());

    const input = bar.querySelector('.list-filter') as HTMLInputElement;
    input.focus();
    input.value = 'calibration';
    input.setSelectionRange(4, 9);
    expect(document.activeElement).toBe(input);

    renderList(list, ROWS);

    expect(document.activeElement).not.toBe(input);
    expect(document.body.contains(input)).toBe(false);
    expect(list.querySelector('.list-filter')).toBeNull();
  });
});

describe('the count readout', () => {
  it('reads "n files" unfiltered and "n of m files" when narrowing', () => {
    const { controls } = mountSiblingLayout();
    const api = makeControls(controls, nextId());
    const count = controls.querySelector('.list-count') as HTMLElement;

    api.apply(ROWS);
    expect(count.textContent).toBe('3 files');

    const input = controls.querySelector('.list-filter') as HTMLInputElement;
    input.value = 'gcode';
    input.dispatchEvent(new Event('input'));
    api.apply(ROWS);
    expect(count.textContent).toBe('3 of 3 files');

    input.value = 'vase';
    input.dispatchEvent(new Event('input'));
    api.apply(ROWS);
    expect(count.textContent).toBe('1 of 3 files');
  });

  it('says nothing at all when there is no data', () => {
    const { controls } = mountSiblingLayout();
    const api = makeControls(controls, nextId());
    const count = controls.querySelector('.list-count') as HTMLElement;

    api.apply([]);
    expect(count.textContent).toBe('');
  });
});

describe('the two empty states', () => {
  it('distinguishes "no data" from "filtered to nothing"', () => {
    const { controls } = mountSiblingLayout();
    const api = makeControls(controls, nextId());

    expect(api.isFiltering()).toBe(false);
    expect(api.emptyHtml('No files on the printer.')).toContain('No files on the printer.');

    const input = controls.querySelector('.list-filter') as HTMLInputElement;
    input.value = 'zzzz';
    input.dispatchEvent(new Event('input'));

    expect(api.isFiltering()).toBe(true);
    const filtered = api.emptyHtml('No files on the printer.');
    expect(filtered).toContain('Nothing matches your filter');
    // The caller's message must NOT leak into the filtered state — they are different
    // facts and that is the whole point of having two.
    expect(filtered).not.toContain('No files on the printer.');
  });
});
