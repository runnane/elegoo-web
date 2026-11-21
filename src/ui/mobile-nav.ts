/**
 * Mobile bottom-tab navigation — pure mapping + DOM wiring.
 *
 * At phone widths (<= 800px), flattening all 16 dashboard cards into one vertical column
 * buries the camera and files thousands of pixels below charts and jog pads. Grouping
 * cards into four dashboard sections (Overview, Control, Files, Monitor) plus a More
 * tab for Settings/Tools/Debug/Help keeps desktop layout untouched while making phone
 * navigation thumb-reachable.
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

/** Card placement and visual order within each mobile dashboard section. */
export const MOBILE_SECTION_CARDS: Record<MobileDashboardSection, readonly string[]> = {
  overview: ['print-status-bar', 'camera-card', 'temps-card', 'canvas-card'],
  control: ['toolhead-card', 'fans-card', 'speed-flow-card'],
  files: ['files-card', 'print-queue-card', 'print-history-card', 'timelapse-card'],
  monitor: ['gcode-preview-card', 'ai-card', 'event-log-card', 'print-reports-card', 'log-card'],
};

const CARD_SECTION_INDEX = new Map<string, { section: MobileDashboardSection; order: number }>();
for (const section of MOBILE_DASHBOARD_SECTIONS) {
  MOBILE_SECTION_CARDS[section].forEach((cardId, idx) => {
    CARD_SECTION_INDEX.set(cardId, { section, order: idx + 1 });
  });
}

/** Return the mobile section and display order for a dashboard card ID. */
export function mobilePlacementForCard(cardId: string): {
  section: MobileDashboardSection;
  order: number;
} {
  return CARD_SECTION_INDEX.get(cardId) ?? { section: 'monitor', order: 99 };
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

/** Tag every dashboard card with its mobile section & flex order (idempotent, non-destructive). */
export function tagMobileCards(): void {
  const dashboard = document.getElementById('dashboard');
  if (!dashboard) return;
  const cards = dashboard.querySelectorAll<HTMLElement>('.card[id]');
  for (const card of cards) {
    const { section, order } = mobilePlacementForCard(card.id);
    card.dataset.mobileSection = section;
    card.style.setProperty('--mobile-order', String(order));
  }
}

function updateNavVisualState(activeNav: MobileSection, activeTab: MainTabId): void {
  document.body.dataset.mobileSection = activeNav;
  document.body.dataset.activeTab = activeTab;

  document.querySelectorAll<HTMLElement>('.mobile-nav-btn').forEach((btn) => {
    const isActive = btn.dataset.mobileNav === activeNav;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-current', isActive ? 'page' : 'false');
  });

  const moreBar = document.getElementById('mobile-more-bar');
  if (moreBar) {
    const showMoreBar = activeTab !== 'dashboard';
    moreBar.classList.toggle('hidden', !showMoreBar);
    moreBar.querySelectorAll<HTMLElement>('.mobile-more-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.moreTab === activeTab);
    });
  }
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
