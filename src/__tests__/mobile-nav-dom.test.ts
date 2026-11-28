// @vitest-environment jsdom
/**
 * ELEG-191 — the bottom nav's wiring, against the real index.html markup and the real
 * `switchToTab` / `initTabRoute`, in main.ts's order.
 *
 * `mobile-nav.test.ts` covers the pure card→section mapping. What only a DOM can show is
 * that the bar, the More sub-bar and the routed tab agree: a `#settings` deep link has to
 * highlight More, not the Overview default `initMobileNav` starts from.
 *
 * `mobile-nav.ts` keeps module-level state (the active section, an init-once flag), so
 * every case re-imports it — and `settings.ts`, which imports it — after
 * `vi.resetModules()`. Visibility is read from explicit hiding (`hidden`, `.hidden`,
 * inline `display`), never geometry: jsdom has no layout.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');
const body = html.slice(html.indexOf('<body'), html.lastIndexOf('</body>'));

type Nav = typeof import('../ui/mobile-nav');
type Settings = typeof import('../ui/settings');
type Route = typeof import('../ui/tab-route');

async function load(): Promise<{ nav: Nav; settings: Settings; route: Route }> {
  vi.resetModules();
  const nav = await import('../ui/mobile-nav');
  const settings = await import('../ui/settings');
  const route = await import('../ui/tab-route');
  return { nav, settings, route };
}

const navBtn = (s: string) =>
  document.querySelector<HTMLElement>(`.mobile-nav-btn[data-mobile-nav="${s}"]`)!;
const moreBtn = (s: string) =>
  document.querySelector<HTMLElement>(`.mobile-more-btn[data-more-tab="${s}"]`)!;
const activeNav = () =>
  [...document.querySelectorAll<HTMLElement>('.mobile-nav-btn.active')].map(
    (b) => b.dataset.mobileNav,
  );
const withAriaCurrent = () =>
  [...document.querySelectorAll<HTMLElement>('.mobile-nav-btn[aria-current]')].map(
    (b) => `${b.dataset.mobileNav}=${b.getAttribute('aria-current')}`,
  );
const moreBarShown = () =>
  !document.getElementById('mobile-more-bar')!.classList.contains('hidden');
const emptyNote = () => document.getElementById('mobile-section-empty')!;

beforeEach(() => {
  document.body.outerHTML = `${body}</body>`;
  document.getElementById('dashboard')!.dataset.connected = 'true';
  window.history.replaceState(null, '', '/');
  sessionStorage.clear();
  localStorage.clear();
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo;
});

describe('mobile bottom nav (ELEG-191)', () => {
  it('the fixture is the real markup: five bar buttons and four More buttons', () => {
    expect(document.querySelectorAll('.mobile-nav-btn')).toHaveLength(5);
    expect(document.querySelectorAll('.mobile-more-btn')).toHaveLength(4);
    expect(document.getElementById('settings-tab-content')).not.toBeNull();
  });

  it('starts on Overview: one aria-current="page", the attribute absent elsewhere', async () => {
    const { nav, settings } = await load();
    settings.applyCardLayout();
    nav.initMobileNav(settings.switchToTab);

    expect(document.body.dataset.mobileSection).toBe('overview');
    expect(activeNav()).toEqual(['overview']);
    // Absent, not aria-current="false".
    expect(withAriaCurrent()).toEqual(['overview=page']);
    expect(moreBarShown()).toBe(false);
    // Cards are tagged from the mapping.
    expect(document.getElementById('camera-card')!.dataset.mobileSection).toBe('overview');
    expect(document.getElementById('files-card')!.dataset.mobileSection).toBe('files');
  });

  it('tapping a section switches to the dashboard and moves the highlight', async () => {
    const { nav } = await load();
    const onSwitch = vi.fn();
    nav.initMobileNav(onSwitch);

    navBtn('files').click();
    expect(onSwitch).toHaveBeenLastCalledWith('dashboard');
    expect(document.body.dataset.mobileSection).toBe('files');
    expect(activeNav()).toEqual(['files']);
    expect(withAriaCurrent()).toEqual(['files=page']);
    expect(sessionStorage.getItem('elegoo-web-mobile-section')).toBe('files');
  });

  it('More opens the last More page, its sub-bar switches pages, and the section is kept', async () => {
    const { nav, settings } = await load();
    settings.applyCardLayout();
    nav.initMobileNav(settings.switchToTab);

    navBtn('control').click();
    navBtn('more').click();
    expect(activeNav()).toEqual(['more']);
    expect(moreBarShown()).toBe(true);
    expect(moreBtn('settings').classList.contains('active')).toBe(true);
    expect(document.getElementById('settings-tab-content')!.classList.contains('hidden')).toBe(
      false,
    );

    moreBtn('tools').click();
    expect(document.getElementById('tools-tab-content')!.classList.contains('hidden')).toBe(false);
    expect(moreBtn('tools').classList.contains('active')).toBe(true);
    expect(moreBtn('settings').classList.contains('active')).toBe(false);
    expect(window.location.hash).toBe('#tools');

    // Back to the dashboard: the section chosen before More, not the Overview default.
    navBtn('control').click();
    expect(document.getElementById('dashboard')!.classList.contains('hidden')).toBe(false);
    expect(moreBarShown()).toBe(false);
    expect(activeNav()).toEqual(['control']);

    // And More remembers Tools.
    navBtn('more').click();
    expect(document.getElementById('tools-tab-content')!.classList.contains('hidden')).toBe(false);
  });

  it('a #settings deep link, routed in main.ts order, highlights More and shows its bar', async () => {
    window.history.replaceState(null, '', '/#settings');
    const { nav, settings, route } = await load();
    settings.applyCardLayout();
    nav.initMobileNav(settings.switchToTab);
    route.initTabRoute(settings.switchToTab);

    expect(document.getElementById('settings-tab-content')!.classList.contains('hidden')).toBe(
      false,
    );
    expect(document.getElementById('dashboard')!.classList.contains('hidden')).toBe(true);
    expect(activeNav()).toEqual(['more']);
    expect(withAriaCurrent()).toEqual(['more=page']);
    expect(moreBarShown()).toBe(true);
    expect(moreBtn('settings').classList.contains('active')).toBe(true);
    expect(document.body.dataset.activeTab).toBe('settings');
  });

  it('a header-tab or keyboard switch (switchToTab alone) keeps the bar in step', async () => {
    const { nav, settings } = await load();
    nav.initMobileNav(settings.switchToTab);

    settings.switchToTab('help');
    expect(activeNav()).toEqual(['more']);
    expect(moreBtn('help').classList.contains('active')).toBe(true);

    settings.switchToTab('dashboard');
    expect(activeNav()).toEqual(['overview']);
    expect(moreBarShown()).toBe(false);
  });

  it('restores the section and More page chosen earlier in the session', async () => {
    // Precondition: sessionStorage really round-trips here; readSession swallows errors,
    // so without this the restore below could pass on defaults. Neither value is one.
    sessionStorage.setItem('probe', 'x');
    expect(sessionStorage.getItem('probe')).toBe('x');

    sessionStorage.setItem('elegoo-web-mobile-section', 'monitor');
    sessionStorage.setItem('elegoo-web-mobile-more-tab', 'debug');
    const { nav } = await load();
    const onSwitch = vi.fn();
    nav.initMobileNav(onSwitch);

    expect(activeNav()).toEqual(['monitor']);
    navBtn('more').click();
    expect(onSwitch).toHaveBeenLastCalledWith('debug');
  });

  it('a section whose cards are all hidden says so instead of rendering blank', async () => {
    const { nav, settings } = await load();
    settings.applyCardLayout();
    nav.initMobileNav(settings.switchToTab);

    navBtn('control').click();
    expect(emptyNote().hidden).toBe(true);

    for (const id of nav.MOBILE_SECTION_CARDS.control) {
      document.getElementById(id)!.style.display = 'none';
    }
    navBtn('files').click();
    expect(emptyNote().hidden).toBe(true);
    navBtn('control').click();
    expect(emptyNote().hidden).toBe(false);
    expect(emptyNote().textContent).toContain('More → Settings → Panel Layout');

    navBtn('more').click();
    expect(emptyNote().hidden).toBe(true);
  });

  it('a hidden sidebar counts as hidden, and the note points at its toggle', async () => {
    const { nav, settings } = await load();
    settings.applyCardLayout();
    nav.initMobileNav(settings.switchToTab);
    navBtn('control').click();

    // The shipped layout keeps every Control card in the sidebar.
    document.getElementById('dashboard-sidebar')!.classList.add('sidebar-hidden');
    nav.refreshMobileSectionEmpty();
    expect(emptyNote().hidden).toBe(false);
    const toggle = document.getElementById('sidebar-toggle')!.textContent!.trim();
    expect(emptyNote().textContent).toContain(`Tap ${toggle} in the header`);

    document.getElementById('dashboard-sidebar')!.classList.remove('sidebar-hidden');
    nav.refreshMobileSectionEmpty();
    expect(emptyNote().hidden).toBe(true);
  });
});
