/**
 * The active main tab, mirrored in `location.hash` (ELEG-175).
 *
 * `#tools` / `#settings` / `#debug` / `#help`; the Dashboard is the empty hash, and an
 * unknown hash also means Dashboard. Every tab switch — click, number key, `?` — goes
 * through `switchToTab`, which calls `syncTabHash`, so there is one path. Pure parse and
 * format live here with no imports, so a test reaches them and `settings.ts` can import
 * this without a cycle.
 */

export type MainTab = 'dashboard' | 'settings' | 'tools' | 'help' | 'debug';

const HASHED_TABS: readonly MainTab[] = ['settings', 'tools', 'help', 'debug'];

/** `#help` → `'help'`; empty or unknown → `'dashboard'`. */
export function parseTabHash(hash: string): MainTab {
  const name = hash.replace(/^#/, '').toLowerCase();
  return HASHED_TABS.find((t) => t === name) ?? 'dashboard';
}

/** `'help'` → `'#help'`; the Dashboard has no hash. */
export function tabHash(tab: MainTab): string {
  return tab === 'dashboard' ? '' : `#${tab}`;
}

/**
 * Reflect `tab` in the URL, pushing one history entry per real change so Back moves
 * between tabs. Does nothing when the hash already resolves to `tab` — that is what stops
 * a `hashchange`-driven switch from pushing again.
 */
export function syncTabHash(tab: MainTab): void {
  if (parseTabHash(window.location.hash) === tab) return;
  const url = `${window.location.pathname}${window.location.search}${tabHash(tab)}`;
  window.history.pushState(null, '', url);
}

/** Open the tab named by the current hash and follow later hash changes (Back, links). */
export function initTabRoute(switchTab: (tab: MainTab) => void): void {
  window.addEventListener('hashchange', () => switchTab(parseTabHash(window.location.hash)));
  const initial = parseTabHash(window.location.hash);
  if (initial !== 'dashboard') switchTab(initial);
}
