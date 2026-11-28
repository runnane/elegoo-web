/**
 * Mobile bottom-tab navigation — pure mapping + DOM wiring (ELEG-191, from PR #181).
 *
 * At phone widths (<= 800px) every dashboard card is one vertical column (ELEG-158), which
 * still leaves the files and the log thousands of pixels down. Grouping the cards into four
 * dashboard sections (Overview, Control, Files, Monitor) plus a More tab for
 * Settings/Tools/Debug/Help makes phone navigation thumb-reachable. The section filter and
 * the bar itself are CSS in `styles/mobile.css`, scoped to `max-width: 800px`; above that
 * the attributes this module writes are inert. Landscape phones (wider than 800px) keep
 * ELEG-158's single column and the header tabs.
 *
 * Pure helpers live at the top so unit tests can exercise them under vitest's node env.
 */

export const MOBILE_DASHBOARD_SECTIONS = ['overview', 'control', 'files', 'monitor'] as const;
export type MobileDashboardSection = (typeof MOBILE_DASHBOARD_SECTIONS)[number];

export const MOBILE_SECTIONS = [...MOBILE_DASHBOARD_SECTIONS, 'more'] as const;
export type MobileSection = (typeof MOBILE_SECTIONS)[number];

export const MORE_SUB_TABS = ['settings', 'tools', 'debug', 'help'] as const;
export type MoreSubTab = (typeof MORE_SUB_TABS)[number];

export type MainTabId = 'dashboard' | MoreSubTab;

/**
 * Which mobile section each dashboard card belongs to. Order *within* a section is not set
 * here: it is main.css's ELEG-158 order (print status, then the camera, then the rest as
 * Settings → Panel Layout arranges them), so the layout settings keep working on phones.
 */
export const MOBILE_SECTION_CARDS: Record<MobileDashboardSection, readonly string[]> = {
  overview: ['print-status-bar', 'camera-card', 'temps-card', 'canvas-card'],
  control: ['toolhead-card', 'fans-card', 'speed-flow-card'],
  files: ['files-card', 'print-queue-card', 'print-history-card', 'timelapse-card'],
  monitor: ['gcode-preview-card', 'ai-card', 'event-log-card', 'print-reports-card', 'log-card'],
};

const CARD_SECTION_INDEX = new Map<string, MobileDashboardSection>();
for (const section of MOBILE_DASHBOARD_SECTIONS) {
  for (const cardId of MOBILE_SECTION_CARDS[section]) CARD_SECTION_INDEX.set(cardId, section);
}

/** The mobile section a dashboard card ID belongs to; an unknown card goes to Monitor. */
export function mobileSectionForCard(cardId: string): MobileDashboardSection {
  return CARD_SECTION_INDEX.get(cardId) ?? 'monitor';
}

/** Validate a stored or user-supplied section name, falling back to 'overview'. */
export function normaliseMobileSection(value: unknown): MobileSection {
  if (typeof value === 'string' && (MOBILE_SECTIONS as readonly string[]).includes(value)) {
    return value as MobileSection;
  }
  return 'overview';
}

/** Validate a stored More sub-tab, falling back to 'settings'. */
export function normaliseMoreSubTab(value: unknown): MoreSubTab {
  if (typeof value === 'string' && (MORE_SUB_TABS as readonly string[]).includes(value)) {
    return value as MoreSubTab;
  }
  return 'settings';
}

const SECTION_STORAGE_KEY = 'elegoo-web-mobile-section';
const MORE_TAB_STORAGE_KEY = 'elegoo-web-mobile-more-tab';

let activeDashboardSection: MobileDashboardSection = 'overview';
let lastMoreSubTab: MoreSubTab = 'settings';
let navInitialised = false;

function readSession(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* ignore storage errors in private browsing */
  }
}

/** Tag every dashboard card with its mobile section (idempotent, non-destructive). */
export function tagMobileCards(): void {
  const dashboard = document.getElementById('dashboard');
  if (!dashboard) return;
  const cards = dashboard.querySelectorAll<HTMLElement>('.card[id]');
  for (const card of cards) {
    card.dataset.mobileSection = mobileSectionForCard(card.id);
  }
  refreshMobileSectionEmpty();
}

/**
 * A card counts as shown unless the layout hid it (`style.display = 'none'` from
 * applyCardLayout) or it sits in a hidden sidebar. Explicit hiding only: jsdom has no
 * layout, and in a browser a card of another section is display:none by design.
 */
function cardIsShown(card: HTMLElement): boolean {
  return card.style.display !== 'none' && !card.closest('.sidebar-hidden');
}

/**
 * Show the "nothing here" note when every card of the active dashboard section is hidden,
 * instead of a blank page. Called on every nav change, after every layout apply, and by
 * the sidebar toggle.
 */
export function refreshMobileSectionEmpty(): void {
  const note = document.getElementById('mobile-section-empty');
  if (!note) return;
  const section = document.body.dataset.mobileSection;
  const cards = [
    ...document.querySelectorAll<HTMLElement>(`#dashboard .card[data-mobile-section="${section}"]`),
  ];
  const empty = section !== 'more' && cards.length > 0 && !cards.some(cardIsShown);
  note.hidden = !empty;
  if (!empty) return;
  const bySidebar = cards.some((c) => c.style.display !== 'none' && c.closest('.sidebar-hidden'));
  note.textContent = bySidebar
    ? 'Every card in this section is hidden. Tap ◧ in the header to show the sidebar, or turn cards on under More → Settings → Panel Layout.'
    : 'Every card in this section is hidden. Turn cards on under More → Settings → Panel Layout.';
}

function updateNavVisualState(activeNav: MobileSection, activeTab: MainTabId): void {
  document.body.dataset.mobileSection = activeNav;
  document.body.dataset.activeTab = activeTab;

  document.querySelectorAll<HTMLElement>('.mobile-nav-btn').forEach((btn) => {
    const isActive = btn.dataset.mobileNav === activeNav;
    btn.classList.toggle('active', isActive);
    // Absent, not "false", on the inactive buttons.
    if (isActive) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });

  const moreBar = document.getElementById('mobile-more-bar');
  if (moreBar) {
    const showMoreBar = activeTab !== 'dashboard';
    moreBar.classList.toggle('hidden', !showMoreBar);
    moreBar.querySelectorAll<HTMLElement>('.mobile-more-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.moreTab === activeTab);
    });
  }

  refreshMobileSectionEmpty();
}

/** Keep mobile bottom nav and More bar aligned whenever switchToTab() is called. */
export function syncMobileNavWithTab(tab: MainTabId): void {
  if (tab === 'dashboard') {
    updateNavVisualState(activeDashboardSection, 'dashboard');
  } else {
    lastMoreSubTab = tab;
    writeSession(MORE_TAB_STORAGE_KEY, tab);
    updateNavVisualState('more', tab);
  }
}

/** Initialise mobile bottom navigation and More sub-tab switcher. */
export function initMobileNav(onSwitchTab: (tab: MainTabId) => void): void {
  if (navInitialised) return;
  navInitialised = true;

  const savedSection = normaliseMobileSection(readSession(SECTION_STORAGE_KEY));
  if (savedSection !== 'more') {
    activeDashboardSection = savedSection;
  }
  lastMoreSubTab = normaliseMoreSubTab(readSession(MORE_TAB_STORAGE_KEY));

  tagMobileCards();
  updateNavVisualState(activeDashboardSection, 'dashboard');

  document.querySelectorAll<HTMLElement>('.mobile-nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = normaliseMobileSection(btn.dataset.mobileNav);
      if (target === 'more') {
        writeSession(SECTION_STORAGE_KEY, 'more');
        onSwitchTab(lastMoreSubTab);
      } else {
        activeDashboardSection = target;
        writeSession(SECTION_STORAGE_KEY, target);
        onSwitchTab('dashboard');
        updateNavVisualState(target, 'dashboard');
      }
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
      // Canvas charts & Three.js gcode preview size to their container; nudge on reveal.
      requestAnimationFrame(() => {
        window.dispatchEvent(new Event('resize'));
      });
    });
  });

  document.querySelectorAll<HTMLElement>('.mobile-more-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const subTab = normaliseMoreSubTab(btn.dataset.moreTab);
      lastMoreSubTab = subTab;
      writeSession(MORE_TAB_STORAGE_KEY, subTab);
      onSwitchTab(subTab);
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
    });
  });
}
