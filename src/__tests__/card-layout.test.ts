import { describe, it, expect } from 'vitest';
import {
  normaliseCardLayout,
  defaultCardLayout,
  ALL_CARD_IDS,
  DEFAULT_SIDEBAR,
  DEFAULT_MAIN,
  CARD_NAMES,
} from '../ui/card-layout';

/** Every card, wherever it ended up. */
function placed(layout: { sidebar: string[]; main: string[] }): string[] {
  return [...layout.sidebar, ...layout.main];
}

describe('defaultCardLayout', () => {
  it('places every known card and hides none', () => {
    const l = defaultCardLayout();
    expect(placed(l).sort()).toEqual([...ALL_CARD_IDS].sort());
    expect(l.hidden).toEqual([]);
    expect(l.collapsed).toEqual([]);
  });

  it('hands out a fresh copy each time, since callers mutate it', () => {
    const a = defaultCardLayout();
    a.sidebar.push('injected');
    expect(defaultCardLayout().sidebar).not.toContain('injected');
  });
});

describe('normaliseCardLayout', () => {
  it('falls back to defaults for anything that is not an object', () => {
    for (const junk of [null, undefined, 'nope', 42, []]) {
      expect(placed(normaliseCardLayout(junk)).sort()).toEqual([...ALL_CARD_IDS].sort());
    }
  });

  it('keeps a saved order rather than reimposing the default one', () => {
    const saved = { sidebar: ['fans-card', 'temps-card'], main: [], hidden: [], collapsed: [] };
    const l = normaliseCardLayout(saved);
    expect(l.sidebar.slice(0, 2)).toEqual(['fans-card', 'temps-card']);
  });

  it('preserves hidden and collapsed cards', () => {
    const l = normaliseCardLayout({
      sidebar: [...DEFAULT_SIDEBAR],
      main: [...DEFAULT_MAIN],
      hidden: ['log-card'],
      collapsed: ['fans-card'],
    });
    expect(l.hidden).toEqual(['log-card']);
    expect(l.collapsed).toEqual(['fans-card']);
  });

  it('backfills a card added after the layout was saved', () => {
    // The case ELEG-44 asked about: a user whose stored layout predates a new card.
    // Without this the card is invisible in the settings list, and the next reorder
    // saves a layout that still does not mention it.
    const stale = {
      sidebar: DEFAULT_SIDEBAR.filter((id) => id !== 'fans-card'),
      main: DEFAULT_MAIN.filter((id) => id !== 'timelapse-card'),
      hidden: [],
      collapsed: [],
    };
    const l = normaliseCardLayout(stale);
    expect(l.sidebar).toContain('fans-card');
    expect(l.main).toContain('timelapse-card');
    expect(placed(l).sort()).toEqual([...ALL_CARD_IDS].sort());
  });

  it('backfills each card into its own default panel', () => {
    const l = normaliseCardLayout({ sidebar: [], main: [], hidden: [], collapsed: [] });
    for (const id of DEFAULT_SIDEBAR) expect(l.sidebar).toContain(id);
    for (const id of DEFAULT_MAIN) expect(l.main).toContain(id);
  });

  it('never lists a card twice, even if storage named it in both panels', () => {
    const l = normaliseCardLayout({
      sidebar: ['temps-card'],
      main: ['temps-card'],
      hidden: [],
      collapsed: [],
    });
    expect(placed(l).filter((id) => id === 'temps-card')).toHaveLength(1);
    expect(l.sidebar).toContain('temps-card'); // first mention wins
  });

  it('migrates the old single-list { order, hidden } format', () => {
    const l = normaliseCardLayout({
      order: ['log-card', 'temps-card', 'files-card'],
      hidden: ['log-card'],
    });
    expect(l.sidebar[0]).toBe('temps-card'); // sidebar card routed to the sidebar
    expect(l.main[0]).toBe('log-card'); // main card routed to main, order kept
    expect(l.hidden).toEqual(['log-card']);
    expect(placed(l).sort()).toEqual([...ALL_CARD_IDS].sort());
  });

  it('drops non-string entries instead of passing them to the DOM pass', () => {
    const l = normaliseCardLayout({
      sidebar: ['temps-card', 42, null],
      main: [{ nope: true }],
      hidden: [7],
      collapsed: [],
    });
    expect(l.sidebar.every((id) => typeof id === 'string')).toBe(true);
    expect(l.main.every((id) => typeof id === 'string')).toBe(true);
    expect(l.hidden).toEqual([]);
  });

  it('keeps an unknown card rather than silently discarding it', () => {
    // A card removed from the app should not make the rest of the layout unreadable.
    const l = normaliseCardLayout({
      sidebar: ['retired-card', ...DEFAULT_SIDEBAR],
      main: [...DEFAULT_MAIN],
      hidden: [],
      collapsed: [],
    });
    expect(l.sidebar).toContain('retired-card');
  });
});

describe('CARD_NAMES', () => {
  it('names every card that can appear in the settings list', () => {
    // An unnamed card renders as its raw element id.
    for (const id of ALL_CARD_IDS) {
      expect(CARD_NAMES[id], `${id} has no display name`).toBeTruthy();
    }
  });
});
