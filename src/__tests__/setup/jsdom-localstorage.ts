/**
 * Give jsdom tests a working `localStorage` (ELEG-64).
 *
 * ## What was wrong
 *
 * Under the `@vitest-environment jsdom` docblock, all access paths to `localStorage`
 * were `undefined` — bare, via `window`, and via `globalThis`. Because
 * `src/ui/ui-settings.ts` wraps every storage access in try/catch and falls back to
 * defaults, nothing threw and nothing was logged. A test asserting "the sort choice is
 * persisted and restored" would have exercised the catch branch, got defaults back, and
 * **passed for the wrong reason** whenever its expectations matched those defaults —
 * which for `listSort` (`{}`) and `listSelect` (`'all'`) they very often would.
 *
 * ## The cause, measured — and it is NOT the one that looks obvious
 *
 * The natural suspicion is jsdom's opaque-origin rule: jsdom throws
 * `SecurityError: localStorage is not available for opaque origins`, and a bare
 * `new JSDOM('')` does exactly that because its document is `about:blank`. That is real,
 * and it is reproducible:
 *
 *     new JSDOM('')                             -> SecurityError on .localStorage
 *     new JSDOM('', { url: 'http://localhost:3000/' })  -> works, round-trips
 *
 * **But it is not what was happening here.** Probed inside the vitest jsdom environment,
 * the origin is already fine:
 *
 *     href = "http://localhost:3000/"   origin = "http://localhost:3000"
 *     typeof window.localStorage = "undefined"
 *
 * So setting `environmentOptions.jsdom.url` fixes nothing — it is already that value.
 *
 * The actual cause is Node itself. Node 26 ships an experimental built-in
 * `localStorage`, and prints on every jsdom test file:
 *
 *     ExperimentalWarning: localStorage is not available because
 *     --localstorage-file was not provided.
 *
 * It is installed on `globalThis` as an **accessor** whose getter returns `undefined`
 * when that flag is absent:
 *
 *     Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
 *       -> { get, set, enumerable, configurable: true }   // getter yields undefined
 *
 * and under vitest `window === globalThis`, so Node's accessor **shadows jsdom's own
 * property**. Reading `window.localStorage` reads Node's, not jsdom's, which is why
 * every path was undefined despite a perfectly good origin.
 *
 * ## The fix
 *
 * The descriptor is `configurable: true`, so it can be replaced. This installs a small
 * in-memory `Storage` on top. A stub rather than jsdom's implementation because jsdom's
 * `Storage` instance is not reachable from inside the environment once shadowed, and
 * rather than `--localstorage-file` because that would make the suite depend on a node
 * flag and write a real file.
 *
 * Only the API `ui-settings.ts` and `list-controls.ts` actually use is needed, but the
 * whole `Storage` surface is implemented so a future caller does not silently hit a
 * missing method — which is the same class of quiet failure this whole issue is about.
 *
 * Node-environment tests are untouched: the guard below is why.
 */

class MemoryStorage implements Storage {
  #map = new Map<string, string>();

  get length(): number {
    return this.#map.size;
  }

  key(index: number): string | null {
    return Array.from(this.#map.keys())[index] ?? null;
  }

  getItem(key: string): string | null {
    return this.#map.get(String(key)) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#map.set(String(key), String(value));
  }

  removeItem(key: string): void {
    this.#map.delete(String(key));
  }

  clear(): void {
    this.#map.clear();
  }

  [name: string]: unknown;
}

// Only for the jsdom environment. In the `node` environment there is no document and no
// browser code under test, so leaving Node's own global alone is correct.
if (typeof document !== 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: new MemoryStorage(),
    writable: true,
    configurable: true,
    enumerable: true,
  });
}
