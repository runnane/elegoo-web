/**
 * Light / dark theme (ELEG-34).
 *
 * The stylesheet was already built on custom properties, so a theme is a second set of
 * values plus a way to choose between them. `data-theme` on `<html>` is that switch.
 *
 * ## Why an attribute and not `@media (prefers-color-scheme: light)`
 *
 * An explicit choice has to be able to override the system preference, and a media
 * query cannot be overridden from JavaScript. Driving everything from one attribute
 * also means the light palette is written once rather than duplicated into a media
 * block and an override block.
 *
 * The attribute is set **before first paint** by a small inline script in `index.html`;
 * doing it from this module would flash dark on a light-preferring system, because the
 * bundle is deferred. This module owns the choice from then on and must agree with that
 * script — the storage key and the values are the contract between them.
 */

import { loadUISettings, saveUISettings } from './ui-settings';
import { invalidateChartPalette } from './chart-palette';

/** `auto` follows the operating system; the other two override it. */
export type ThemeChoice = 'auto' | 'dark' | 'light';

/** What actually gets applied. `auto` resolves to one of these. */
export type ResolvedTheme = 'dark' | 'light';

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === 'auto' || value === 'dark' || value === 'light';
}

/** Resolve a choice against the system preference. Pure. */
export function resolveTheme(choice: ThemeChoice, prefersLight: boolean): ResolvedTheme {
  if (choice === 'dark' || choice === 'light') return choice;
  return prefersLight ? 'light' : 'dark';
}

function systemPrefersLight(): boolean {
  return (
    typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches === true
  );
}

/** The saved choice, defaulting to `auto`. */
export function getThemeChoice(): ThemeChoice {
  const saved = loadUISettings().theme;
  return isThemeChoice(saved) ? saved : 'auto';
}

/** Put the resolved theme on `<html>` and drop the cached canvas palette. */
function apply(resolved: ResolvedTheme): void {
  document.documentElement.setAttribute('data-theme', resolved);
  // The charts read their colours from the stylesheet once and cache the result, so a
  // theme change that skipped this would leave every canvas on the old palette until
  // the page reloaded — the half-themed dashboard ELEG-34 exists to avoid.
  invalidateChartPalette();
}

/** Persist a choice and apply it immediately. */
export function setThemeChoice(choice: ThemeChoice): void {
  saveUISettings({ theme: choice });
  apply(resolveTheme(choice, systemPrefersLight()));
}

/**
 * Re-apply the stored choice, and follow the system while the choice is `auto`.
 *
 * Called once at startup. The attribute is normally already correct — the inline script
 * set it — but this re-asserts it from the same source of truth and installs the
 * listener that keeps `auto` honest when the OS flips at sunset.
 */
export function initTheme(): void {
  apply(resolveTheme(getThemeChoice(), systemPrefersLight()));

  if (typeof matchMedia !== 'function') return;
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
    if (getThemeChoice() !== 'auto') return;
    apply(e.matches ? 'light' : 'dark');
  });
}
