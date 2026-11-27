import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ELEG-164 — the phone layout's single column must be able to shrink below its widest
 * card's min-content.
 *
 * No gate here has a layout engine (jsdom reports every box as 0×0), so the fix was
 * measured in headless Chromium against production's DOM: the track went from ~1558px to
 * 378px at a 390px viewport. This file pins the two declarations that measurement
 * depended on, so a revert to a bare `1fr` or the loss of `min-width: 0` goes red even
 * though nothing else can see it.
 */

const css = readFileSync(fileURLToPath(new URL('../styles/main.css', import.meta.url)), 'utf8');

/** The body of the first `@media (<query>) { … }` block, braces balanced. */
function mediaBlock(query: string): string {
  const start = css.indexOf(`@media (${query}) {`);
  expect(start, `@media (${query}) present`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error('unbalanced braces');
}

/** The declarations of the first rule in `scope` whose selector list is exactly `selector`. */
function ruleBody(scope: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&').replace(/\s+/g, '\\s*');
  const m = scope.match(new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`));
  expect(m, `rule "${selector}" present`).not.toBeNull();
  return m![1];
}

describe('phone layout grid (ELEG-164)', () => {
  it('the ≤800px column is minmax(0, 1fr), not a bare 1fr', () => {
    const body = ruleBody(mediaBlock('max-width: 800px'), '.dashboard-sidebar, .dashboard-main');
    expect(body).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  });

  it('dashboard cards may shrink below their min-content', () => {
    const body = ruleBody(css, '.dashboard-main > *, .dashboard-sidebar > *');
    expect(body).toMatch(/min-width:\s*0\s*;/);
  });

  it('the five tabs share the row on a narrow phone instead of scrolling Help away', () => {
    const body = ruleBody(mediaBlock('max-width: 480px'), '.main-tab');
    expect(body).toMatch(/flex:\s*1 1 0/);
    expect(body).toMatch(/min-width:\s*0/);
  });
});
