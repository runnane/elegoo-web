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
/** Loaded after main.css (ELEG-191), so a rule here silently beats one there. */
const mobileCss = readFileSync(
  fileURLToPath(new URL('../styles/mobile.css', import.meta.url)),
  'utf8',
);

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

  it('on phones the card column clips overflow itself, since its panels are display: contents (ELEG-158)', () => {
    // The panels step out of the box tree on phones, taking `.dashboard-main`'s
    // overflow-x clip with them. Measured in headless Chromium without this rule: a
    // 4000-character unbreakable line made the document 28021px wide at 390px.
    const phones = mediaBlock('max-width: 800px), (max-width: 1200px) and (max-height: 500px');
    expect(ruleBody(phones, '.dashboard-sidebar:not(.sidebar-hidden), .dashboard-main')).toMatch(
      /display:\s*contents/,
    );
    // `clip`, not `hidden`: hidden would make the panels a second scroll container.
    expect(ruleBody(phones, '.dashboard-panels')).toMatch(/overflow-x:\s*clip\s*;/);
  });

  it('the five tabs share the row on a narrow phone instead of scrolling Help away', () => {
    const body = ruleBody(mediaBlock('max-width: 480px'), '.main-tab');
    expect(body).toMatch(/flex:\s*1 1 0/);
    expect(body).toMatch(/min-width:\s*0/);
  });
});

interface CssRule {
  /** The enclosing at-rule preludes, outermost first — `@media (max-width: 800px)`. */
  media: string[];
  selector: string;
  /** `property: value` pairs, lower-cased property, value without `!important`. */
  decls: { prop: string; value: string; important: boolean }[];
}

/** Every style rule in a stylesheet, with the at-rules it sits in. Nested @media is fine. */
function parseRules(source: string): CssRule[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: CssRule[] = [];
  const walk = (from: number, to: number, media: string[]): void => {
    let i = from;
    while (i < to) {
      const open = text.indexOf('{', i);
      if (open < 0 || open >= to) return;
      const prelude = text.slice(i, open).trim();
      let depth = 0;
      let close = open;
      for (; close < to; close++) {
        if (text[close] === '{') depth++;
        else if (text[close] === '}' && --depth === 0) break;
      }
      if (prelude.startsWith('@')) {
        walk(open + 1, close, [...media, prelude.replace(/\s+/g, ' ')]);
      } else {
        const decls = text
          .slice(open + 1, close)
          .split(';')
          .map((d) => d.trim())
          .filter((d) => d.includes(':'))
          .map((d) => {
            const colon = d.indexOf(':');
            const raw = d.slice(colon + 1).trim();
            return {
              prop: d.slice(0, colon).trim().toLowerCase(),
              value: raw.replace(/\s*!important$/, ''),
              important: /!important$/.test(raw),
            };
          });
        rules.push({ media, selector: prelude.replace(/\s+/g, ' '), decls });
      }
      i = close + 1;
    }
  };
  walk(0, text.length, []);
  return rules;
}

/**
 * ELEG-191 — mobile.css (PR #181's bottom nav) loads after main.css, so every guarantee
 * above can be undone there without any test above noticing: they read main.css only. As
 * first submitted it did exactly that — `display: contents !important` on the panels (which
 * voided `.dashboard-panels`' overflow clip and outranked `.sidebar-hidden`) and
 * `object-fit: cover` with a 16/9 box on the camera (cropping the frame ELEG-158 letterboxes).
 */
describe('mobile.css leaves the ELEG-158 / ELEG-164 phone layout to main.css (ELEG-191)', () => {
  const rules = parseRules(mobileCss);

  it('parses: the bottom nav rule is found inside the ≤800px block', () => {
    // Guards the scanner itself — an empty parse would make every test below vacuous.
    const nav = rules.find((r) => r.selector === '.mobile-bottom-nav' && r.media.length === 1);
    expect(nav?.media).toEqual(['@media (max-width: 800px)']);
    expect(nav?.decls.find((d) => d.prop === 'display')?.value).toBe('grid');
  });

  // Owned by main.css: the panels' box model and clip, the column template, the sidebar's
  // hidden state, the header tabs' own sizing, and every camera / camera-modal box.
  const PROTECTED =
    /\.dashboard-(panels|sidebar|main)\b|\.sidebar-(hidden|resize-handle)\b|\.main-tab\b|\.camera-(wrap|img)\b|#camera-feed\b|\.camera-modal(-content|-img)?(?![\w-])/;
  const OWNED_PROPS =
    /^(display|overflow(-[xy])?|grid-template-columns|object-fit|aspect-ratio|(max-|min-)?(height|width)|flex(-direction)?|order)$/;

  it('declares nothing main.css owns on the panels, the tabs or the camera', () => {
    const offending = rules.flatMap((r) =>
      PROTECTED.test(r.selector)
        ? r.decls.filter((d) => OWNED_PROPS.test(d.prop)).map((d) => `${r.selector} { ${d.prop} }`)
        : [],
    );
    expect(offending).toEqual([]);
  });

  it('never crops: any object-fit in mobile.css is contain', () => {
    const fits = rules.flatMap((r) =>
      r.decls.filter((d) => d.prop === 'object-fit').map((d) => `${r.selector}: ${d.value}`),
    );
    expect(fits.every((f) => f.endsWith(': contain'))).toBe(true);
    expect(fits.filter((f) => /camera/.test(f))).toEqual([]);
  });

  it('touches no camera image box, whatever the selector spelling', () => {
    // A second net under PROTECTED: any rule naming the camera may set padding or wrap
    // its header, but no size, fit or aspect.
    // The modal's close button is the one camera rule allowed a size (a touch target).
    const camera = rules.filter(
      (r) => /camera/.test(r.selector) && !/camera-modal-close/.test(r.selector),
    );
    expect(camera.length).toBeGreaterThan(0);
    const sizing = camera.flatMap((r) =>
      r.decls
        .filter((d) => /^(object-fit|aspect-ratio|(max-|min-)?height)$/.test(d.prop))
        .map((d) => `${r.selector} { ${d.prop}: ${d.value} }`),
    );
    expect(sizing).toEqual([]);
  });

  it('every layout rule is phone-only; the few global ones are named here', () => {
    const GLOBAL = new Set([
      'body', // the side safe-area insets viewport-fit=cover needs; 0 without a notch
      '.mobile-bottom-nav, .mobile-more-bar, .mobile-section-empty',
      '.print-thumbnail-placeholder.is-text',
      '.file-popover-header',
      '.file-popover-close',
      '.file-popover-close:hover',
    ]);
    const phoneOrNarrower =
      /^@media \((max-width: (800|[1-7]\d\d|\d\d)px|hover: hover\) and \(pointer: fine)\)$/;
    const stray = rules
      .filter((r) =>
        r.media.length === 0 ? !GLOBAL.has(r.selector) : !phoneOrNarrower.test(r.media[0]),
      )
      .map((r) => `${r.media.join(' ')} ${r.selector}`);
    expect(stray).toEqual([]);
  });

  it('the ⋯ button and the popover × are hidden on mouse-and-hover screens', () => {
    const hoverRule = rules.find((r) => r.media[0] === '@media (hover: hover) and (pointer: fine)');
    expect(hoverRule?.selector).toBe('.file-actions .file-info-btn, .file-popover-close');
    expect(hoverRule?.decls).toEqual([{ prop: 'display', value: 'none', important: false }]);
  });

  it('the header tabs give way to the bottom nav at ≤800px, except on the connect screen', () => {
    const hide = rules.find(
      (r) => r.media[0] === '@media (max-width: 800px)' && /\.header-center$/.test(r.selector),
    );
    expect(hide?.selector).toBe(
      'body:not(:has(#connect-dialog:not(.hidden))) #app-header .header-center',
    );
    expect(hide?.decls).toEqual([{ prop: 'display', value: 'none', important: false }]);
  });

  it('leaves card order to main.css, so print status and the camera stay first (ELEG-158)', () => {
    // #181 set `order` on every card, which outranked main.css's -2 / -1 for print status
    // and the camera and made Settings → Panel Layout's order dead on phones.
    const orders = rules.flatMap((r) =>
      r.decls.filter((d) => d.prop === 'order').map((d) => `${r.selector} { order: ${d.value} }`),
    );
    expect(orders).toEqual([]);
  });

  it('keeps !important to the one iOS input-zoom guard', () => {
    const important = rules.flatMap((r) =>
      r.decls.filter((d) => d.important).map((d) => `${r.selector} { ${d.prop} }`),
    );
    expect(important).toHaveLength(1);
    expect(important[0]).toMatch(/\{ font-size \}$/);
  });
});
