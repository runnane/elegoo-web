/** Settings panel — persistent card layout + Telegram config */

import { $, fetchTimeout } from './helpers';
import { toast } from './toast';
import { renderSpoolCalc } from './spool-calc';
import { renderHelp } from './help';

// ---- Card layout settings (localStorage) ----

interface CardLayout {
  sidebar: string[];
  main: string[];
  hidden: string[];
  collapsed: string[];
}

/** Default sidebar cards (always-visible essentials) */
const DEFAULT_SIDEBAR = [
  'temps-card',
  'canvas-card',
  'fans-card',
  'toolhead-card',
  'speed-flow-card',
];

/** Default main area cards (detail/reference) */
const DEFAULT_MAIN = [
  'camera-card',
  'gcode-preview-card',
  'files-card',
  'print-history-card',
  'print-reports-card',
  'timelapse-card',
  'ai-card',
  'event-log-card',
  'log-card',
];

/** All known card IDs */
const ALL_CARD_IDS = [...DEFAULT_SIDEBAR, ...DEFAULT_MAIN];

/** Human-readable names for cards */
const CARD_NAMES: Record<string, string> = {
  'temps-card': '🌡️ Temperatures',
  'canvas-card': '🎨 Canvas / AMS',
  'camera-card': '📷 Camera',
  'ai-card': '🤖 AI Monitor',
  'event-log-card': '📜 Event Log',
  'gcode-preview-card': '📐 Layer Preview',
  'toolhead-card': '🎯 Toolhead',
  'fans-card': '🌀 Fans',
  'speed-flow-card': '⚡ Speed & Flow',
  'files-card': '📁 Files',
  'print-history-card': '📜 Print History',
  'print-reports-card': '📊 Print Reports',
  'timelapse-card': '🎬 Timelapse',
  'log-card': '📋 MQTT Log',
};

const STORAGE_KEY = 'elegoo-web-card-layout';

function loadCardLayout(): CardLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Migrate from old format { order: string[], hidden: string[] }
      if (Array.isArray(parsed.order)) {
        return migrateOldLayout(parsed);
      }
      return {
        sidebar: Array.isArray(parsed.sidebar) ? parsed.sidebar : [...DEFAULT_SIDEBAR],
        main: Array.isArray(parsed.main) ? parsed.main : [...DEFAULT_MAIN],
        hidden: Array.isArray(parsed.hidden) ? parsed.hidden : [],
        collapsed: Array.isArray(parsed.collapsed) ? parsed.collapsed : [],
      };
    }
  } catch {
    /* ignore */
  }
  return { sidebar: [...DEFAULT_SIDEBAR], main: [...DEFAULT_MAIN], hidden: [], collapsed: [] };
}

/** Migrate from old single-list layout to sidebar+main format */
function migrateOldLayout(old: { order: string[]; hidden: string[] }): CardLayout {
  const sidebar: string[] = [];
  const main: string[] = [];
  for (const id of old.order) {
    if (DEFAULT_SIDEBAR.includes(id)) sidebar.push(id);
    else main.push(id);
  }
  // Add any cards missing from old layout
  for (const id of DEFAULT_SIDEBAR) {
    if (!sidebar.includes(id)) sidebar.push(id);
  }
  for (const id of DEFAULT_MAIN) {
    if (!main.includes(id)) main.push(id);
  }
  return { sidebar, main, hidden: old.hidden || [], collapsed: [] };
}

function saveCardLayout(layout: CardLayout): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
}

let currentLayout = loadCardLayout();

/** Toggle a card's collapsed state */
export function toggleCardCollapse(cardId: string): void {
  const idx = currentLayout.collapsed.indexOf(cardId);
  if (idx >= 0) {
    currentLayout.collapsed.splice(idx, 1);
  } else {
    currentLayout.collapsed.push(cardId);
  }
  const card = document.getElementById(cardId);
  if (card) card.classList.toggle('collapsed', currentLayout.collapsed.includes(cardId));
  saveCardLayout(currentLayout);
}

/** Apply card order, panel assignment, visibility, and collapse to the DOM */
export function applyCardLayout(): void {
  const sidebar = document.getElementById('dashboard-sidebar');
  const main = document.getElementById('dashboard-main');
  if (!sidebar || !main) return;

  // Ensure all known card IDs exist in either sidebar or main
  for (const id of ALL_CARD_IDS) {
    if (!currentLayout.sidebar.includes(id) && !currentLayout.main.includes(id)) {
      if (DEFAULT_SIDEBAR.includes(id)) {
        currentLayout.sidebar.push(id);
      } else {
        currentLayout.main.push(id);
      }
    }
  }

  // Move cards into sidebar in order
  for (const id of currentLayout.sidebar) {
    const card = document.getElementById(id);
    if (card) {
      sidebar.appendChild(card);
      card.style.display = currentLayout.hidden.includes(id) ? 'none' : '';
      card.classList.toggle('collapsed', currentLayout.collapsed.includes(id));
    }
  }

  // Move cards into main in order
  for (const id of currentLayout.main) {
    const card = document.getElementById(id);
    if (card) {
      main.appendChild(card);
      card.style.display = currentLayout.hidden.includes(id) ? 'none' : '';
      card.classList.toggle('collapsed', currentLayout.collapsed.includes(id));
    }
  }

  // Bind collapse toggle on card headers (idempotent via data attribute)
  const allCards = [...sidebar.children, ...main.children] as HTMLElement[];
  for (const card of allCards) {
    if (!card.id || card.dataset.collapseInit) continue;
    card.dataset.collapseInit = '1';
    const header =
      (card.querySelector('.card-header, .card-head, .files-header, .log-header') as HTMLElement) ||
      (card.querySelector('h3') as HTMLElement);
    if (!header) continue;
    header.style.cursor = 'pointer';
    header.addEventListener('click', (e) => {
      // Don't collapse when clicking buttons/inputs/selects inside the header
      const t = e.target as HTMLElement;
      if (t.closest('button, input, select, label, a, .toggle')) return;
      toggleCardCollapse(card.id);
    });
  }
}

// ---- Settings Tab ----

let settingsRendered = false;

/** Switch to the Settings tab */
export function openSettings(): void {
  switchToTab('settings');
  renderSettingsContent();
}

/** Switch between main tabs (dashboard / settings / tools / help / debug) */
export function switchToTab(tab: 'dashboard' | 'settings' | 'tools' | 'help' | 'debug'): void {
  const connectDialog = document.getElementById('connect-dialog');
  const dashboard = document.getElementById('dashboard');
  const settingsPage = document.getElementById('settings-tab-content');
  const toolsPage = document.getElementById('tools-tab-content');
  const helpPage = document.getElementById('help-tab-content');
  const debugPage = document.getElementById('debug-tab-content');
  const tabs = document.querySelectorAll('.main-tab');

  if (!dashboard || !settingsPage) return;

  tabs.forEach((t) => {
    const el = t as HTMLElement;
    el.classList.toggle('active', el.dataset.tab === tab);
  });

  // Hide all pages first
  settingsPage.classList.add('hidden');
  toolsPage?.classList.add('hidden');
  helpPage?.classList.add('hidden');
  debugPage?.classList.add('hidden');
  dashboard.classList.add('hidden');
  connectDialog?.classList.add('hidden');

  if (tab === 'dashboard') {
    // Show dashboard (or connect dialog if not yet connected)
    if (dashboard.dataset.connected !== 'true' && connectDialog) {
      connectDialog.classList.remove('hidden');
    } else {
      dashboard.classList.remove('hidden');
    }
  } else if (tab === 'settings') {
    settingsPage.classList.remove('hidden');
    renderSettingsContent();
  } else if (tab === 'tools') {
    toolsPage?.classList.remove('hidden');
    renderSpoolCalc();
  } else if (tab === 'help') {
    helpPage?.classList.remove('hidden');
    renderHelp();
  } else if (tab === 'debug') {
    debugPage?.classList.remove('hidden');
  }
}

/** Render settings content into the settings page (called on tab switch) */
export function renderSettingsContent(): void {
  const content = document.getElementById('settings-content');
  if (!content) return;
  if (settingsRendered) return;
  settingsRendered = true;

  buildSettingsHTML(content);
}

function buildSettingsHTML(content: HTMLElement): void {
  currentLayout = loadCardLayout();

  // Build card list grouped by panel
  function buildCardRows(cards: string[], panel: 'sidebar' | 'main'): string {
    return cards
      .map((id) => {
        const name = CARD_NAMES[id] || id;
        const isHidden = currentLayout.hidden.includes(id);
        return `
        <div class="settings-card-row" data-card-id="${id}" data-panel="${panel}">
          <span class="settings-drag-handle" title="Drag to reorder">⠿</span>
          <label class="settings-card-label">
            <input type="checkbox" class="settings-card-visible" data-card-id="${id}" ${isHidden ? '' : 'checked'}>
            <span>${name}</span>
          </label>
          <select class="settings-card-panel log-select" data-card-id="${id}">
            <option value="sidebar" ${panel === 'sidebar' ? 'selected' : ''}>Sidebar</option>
            <option value="main" ${panel === 'main' ? 'selected' : ''}>Main</option>
          </select>
          <span class="settings-card-move">
            <button class="btn btn-sm btn-ghost settings-move-up" data-card-id="${id}" data-panel="${panel}" title="Move up">▲</button>
            <button class="btn btn-sm btn-ghost settings-move-down" data-card-id="${id}" data-panel="${panel}" title="Move down">▼</button>
          </span>
        </div>
      `;
      })
      .join('');
  }

  content.innerHTML = `
    <section class="settings-section">
      <h3>Panel Layout</h3>
      <p class="settings-hint">Assign cards to the sidebar (always-visible) or main area. Reorder within each panel.</p>
      <h4 class="settings-panel-heading">Sidebar</h4>
      <div id="settings-card-list-sidebar" class="settings-card-list">
        ${buildCardRows(currentLayout.sidebar, 'sidebar')}
      </div>
      <h4 class="settings-panel-heading">Main Area</h4>
      <div id="settings-card-list-main" class="settings-card-list">
        ${buildCardRows(currentLayout.main, 'main')}
      </div>
      <div class="settings-actions">
        <button id="settings-reset-layout" class="btn btn-sm btn-ghost">Reset to default</button>
      </div>
    </section>

    <section class="settings-section">
      <h3>Telegram</h3>
      <div id="settings-telegram" class="settings-telegram">
        <p class="settings-hint">Telegram settings are configured via environment variables in <code>.env</code> and require a service restart.</p>
        <div id="settings-telegram-status"></div>
      </div>
    </section>

    <section class="settings-section">
      <h3>AI Local Labels</h3>
      <p class="settings-hint">Customize the CLIP/SigLIP classification labels, their severity types, and detection thresholds.</p>
      <div id="settings-ai-labels">
        <div class="settings-hint">Loading...</div>
      </div>
    </section>
  `;

  // Bind card visibility toggles
  content.querySelectorAll('.settings-card-visible').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      const cardId = input.dataset.cardId!;
      if (input.checked) {
        currentLayout.hidden = currentLayout.hidden.filter((h) => h !== cardId);
      } else {
        if (!currentLayout.hidden.includes(cardId)) {
          currentLayout.hidden.push(cardId);
        }
      }
      saveCardLayout(currentLayout);
      applyCardLayout();
    });
  });

  // Bind panel (sidebar/main) selector
  content.querySelectorAll('.settings-card-panel').forEach((sel) => {
    sel.addEventListener('change', (e) => {
      const select = e.target as HTMLSelectElement;
      const cardId = select.dataset.cardId!;
      const newPanel = select.value as 'sidebar' | 'main';
      // Remove from current panel
      currentLayout.sidebar = currentLayout.sidebar.filter((id) => id !== cardId);
      currentLayout.main = currentLayout.main.filter((id) => id !== cardId);
      // Add to new panel
      if (newPanel === 'sidebar') {
        currentLayout.sidebar.push(cardId);
      } else {
        currentLayout.main.push(cardId);
      }
      saveCardLayout(currentLayout);
      applyCardLayout();
      settingsRendered = false;
      renderSettingsContent();
    });
  });

  // Bind move up/down buttons (works within the card's current panel)
  content.querySelectorAll('.settings-move-up').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cardId = (btn as HTMLElement).dataset.cardId!;
      const panel = (btn as HTMLElement).dataset.panel as 'sidebar' | 'main';
      const list = panel === 'sidebar' ? currentLayout.sidebar : currentLayout.main;
      const idx = list.indexOf(cardId);
      if (idx > 0) {
        [list[idx - 1], list[idx]] = [list[idx], list[idx - 1]];
        saveCardLayout(currentLayout);
        applyCardLayout();
        settingsRendered = false;
        renderSettingsContent();
      }
    });
  });

  content.querySelectorAll('.settings-move-down').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cardId = (btn as HTMLElement).dataset.cardId!;
      const panel = (btn as HTMLElement).dataset.panel as 'sidebar' | 'main';
      const list = panel === 'sidebar' ? currentLayout.sidebar : currentLayout.main;
      const idx = list.indexOf(cardId);
      if (idx < list.length - 1) {
        [list[idx], list[idx + 1]] = [list[idx + 1], list[idx]];
        saveCardLayout(currentLayout);
        applyCardLayout();
        settingsRendered = false;
        renderSettingsContent();
      }
    });
  });

  // Reset button
  content.querySelector('#settings-reset-layout')?.addEventListener('click', () => {
    currentLayout = {
      sidebar: [...DEFAULT_SIDEBAR],
      main: [...DEFAULT_MAIN],
      hidden: [],
      collapsed: [],
    };
    saveCardLayout(currentLayout);
    applyCardLayout();
    settingsRendered = false;
    renderSettingsContent();
    toast('Layout reset to default', 'success');
  });

  // Load telegram status
  loadTelegramStatus();
  // Load AI label configs
  loadAILabels();
}

async function loadTelegramStatus(): Promise<void> {
  const container = $('settings-telegram-status');
  if (!container) return;

  try {
    const res = await fetchTimeout('/api/config/telegram');
    if (!res.ok) {
      container.innerHTML = '<span class="settings-hint">Could not load Telegram config</span>';
      return;
    }
    const data = (await res.json()) as {
      enabled: boolean;
      chatId: string;
      progressInterval: number;
      botUsername?: string;
    };

    if (!data.enabled) {
      container.innerHTML = `
        <div class="settings-telegram-row">
          <span class="ai-config-off">Disabled</span>
          <span class="settings-hint">Set <code>TELEGRAM_BOT_TOKEN</code> and <code>TELEGRAM_CHAT_ID</code> in <code>.env</code></span>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div class="settings-telegram-row">
        <span class="ai-config-on">Enabled</span>
        ${data.botUsername ? `<span class="settings-hint">Bot: @${data.botUsername}</span>` : ''}
      </div>
      <div class="settings-telegram-field">
        <label>Chat ID</label>
        <input type="text" class="settings-input" value="${data.chatId}" disabled>
      </div>
      <div class="settings-telegram-field">
        <label>Progress interval</label>
        <div class="settings-input-row">
          <input type="number" id="settings-tg-progress" class="settings-input" value="${data.progressInterval}" min="5" max="50" step="5">
          <span class="settings-hint">%</span>
          <button id="settings-tg-save" class="btn btn-sm btn-primary">Save</button>
        </div>
      </div>
    `;

    container.querySelector('#settings-tg-save')?.addEventListener('click', async () => {
      const input = container.querySelector('#settings-tg-progress') as HTMLInputElement;
      const val = parseInt(input.value, 10);
      if (isNaN(val) || val < 5 || val > 50) {
        toast('Invalid interval (5-50)', 'error');
        return;
      }
      try {
        const saveRes = await fetchTimeout('/api/config/telegram', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ progressInterval: val }),
        });
        if (saveRes.ok) {
          toast('Telegram settings saved', 'success');
        } else {
          toast('Failed to save', 'error');
        }
      } catch {
        toast('Network error', 'error');
      }
    });
  } catch {
    container.innerHTML = '<span class="settings-hint">Could not reach service</span>';
  }
}

// ---- AI Label Configuration ----

interface AILabelConfig {
  label: string;
  issueType: string;
  severity: 'ok' | 'warning' | 'critical';
  warnThreshold: number;
  critThreshold: number;
  group: string;
}

async function loadAILabels(): Promise<void> {
  const container = $('settings-ai-labels');
  if (!container) return;

  try {
    const res = await fetchTimeout('/api/config/ai-labels');
    if (!res.ok) {
      container.innerHTML = '<span class="settings-hint">Could not load AI label config</span>';
      return;
    }
    const data = (await res.json()) as { labels: AILabelConfig[]; enabled: boolean };

    if (!data.enabled) {
      container.innerHTML = `
        <div class="settings-hint">AI local classification is not enabled. Set <code>AI_ENABLED=true</code> and <code>AI_LOCAL_ENABLED=true</code> in <code>.env</code>.</div>
      `;
      return;
    }

    renderAILabelEditor(container, data.labels);
  } catch {
    container.innerHTML = '<span class="settings-hint">Could not reach service</span>';
  }
}

function renderAILabelEditor(container: HTMLElement, labels: AILabelConfig[]): void {
  const rows = labels
    .map((lc, idx) => {
      const sevOpts = ['ok', 'warning', 'critical']
        .map(
          (s) =>
            `<option value="${s}" ${lc.severity === s ? 'selected' : ''}>${s.toUpperCase()}</option>`,
        )
        .join('');
      const groupOpts = [
        'Print in Progress',
        'Spaghetti/Failure',
        'Empty Bed',
        'Paused/Stopped',
        'Other',
      ]
        .map((g) => `<option value="${g}" ${lc.group === g ? 'selected' : ''}>${g}</option>`)
        .join('');
      return `
      <div class="ai-label-config-row" data-idx="${idx}">
        <div class="ai-label-config-field ai-label-config-label">
          <label>Label</label>
          <textarea class="settings-input ai-lc-label" rows="2" data-idx="${idx}" title="${lc.label}">${lc.label}</textarea>
        </div>
        <div class="ai-label-config-field">
          <label>Issue Type</label>
          <input type="text" class="settings-input ai-lc-issue" value="${lc.issueType}" data-idx="${idx}" placeholder="e.g. spaghetti">
        </div>
        <div class="ai-label-config-field">
          <label>Group</label>
          <select class="settings-input ai-lc-group" data-idx="${idx}">${groupOpts}</select>
        </div>
        <div class="ai-label-config-field">
          <label>Severity</label>
          <select class="settings-input ai-lc-severity" data-idx="${idx}">${sevOpts}</select>
        </div>
        <div class="ai-label-config-field">
          <label>Warn @</label>
          <input type="number" class="settings-input ai-lc-warn" value="${lc.warnThreshold}" data-idx="${idx}" min="0" max="1" step="0.05">
        </div>
        <div class="ai-label-config-field">
          <label>Crit @</label>
          <input type="number" class="settings-input ai-lc-crit" value="${lc.critThreshold}" data-idx="${idx}" min="0" max="1" step="0.05">
        </div>
        <div class="ai-label-config-field ai-label-config-delete">
          <label>&nbsp;</label>
          <button class="btn btn-sm btn-ghost ai-lc-delete" data-idx="${idx}" title="Delete this label">✕</button>
        </div>
      </div>
    `;
    })
    .join('');

  container.innerHTML = `
    <div class="ai-label-config-list">${rows}</div>
    <div class="settings-actions">
      <button id="ai-labels-add" class="btn btn-sm btn-ghost">➕ Add Label</button>
      <button id="ai-labels-save" class="btn btn-sm btn-primary">Save Labels</button>
      <button id="ai-labels-reset" class="btn btn-sm btn-ghost">Reset to Defaults</button>
    </div>
  `;

  // Delete label buttons
  container.querySelectorAll('.ai-lc-delete').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt((btn as HTMLElement).dataset.idx!, 10);
      const current = collectLabelConfigs(container);
      if (!current) return;
      current.splice(idx, 1);
      renderAILabelEditor(container, current);
    });
  });

  // Add label button
  container.querySelector('#ai-labels-add')?.addEventListener('click', () => {
    const current = collectLabelConfigs(container);
    if (!current) return;
    current.push({
      label: '',
      issueType: 'ok',
      severity: 'ok',
      warnThreshold: 0.5,
      critThreshold: 0.8,
      group: 'Other',
    });
    renderAILabelEditor(container, current);
  });

  container.querySelector('#ai-labels-save')?.addEventListener('click', async () => {
    const updated = collectLabelConfigs(container);
    if (!updated) return;
    if (updated.length === 0) {
      toast('Add at least one label', 'error');
      return;
    }
    const emptyIdx = updated.findIndex((l) => !l.label);
    if (emptyIdx >= 0) {
      toast(`Label ${emptyIdx + 1} cannot be empty`, 'error');
      return;
    }
    try {
      const res = await fetchTimeout('/api/config/ai-labels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labels: updated }),
      });
      if (res.ok) {
        toast('AI label config saved', 'success');
      } else {
        const err = await res.json().catch(() => ({ error: 'Unknown' }));
        toast(`Save failed: ${(err as { error: string }).error}`, 'error');
      }
    } catch {
      toast('Network error', 'error');
    }
  });

  container.querySelector('#ai-labels-reset')?.addEventListener('click', async () => {
    if (!confirm('Reset all AI label configs to defaults?')) return;
    try {
      const res = await fetchTimeout('/api/config/ai-labels', { method: 'DELETE' });
      if (res.ok) {
        const data = (await res.json()) as { labels: AILabelConfig[] };
        renderAILabelEditor(container, data.labels);
        toast('AI labels reset to defaults', 'success');
      } else {
        toast('Reset failed', 'error');
      }
    } catch {
      toast('Network error', 'error');
    }
  });
}

function collectLabelConfigs(container: HTMLElement): AILabelConfig[] | null {
  const rows = container.querySelectorAll('.ai-label-config-row');
  const configs: AILabelConfig[] = [];
  for (const row of rows) {
    const idx = (row as HTMLElement).dataset.idx!;
    const label = (
      row.querySelector(`.ai-lc-label[data-idx="${idx}"]`) as HTMLTextAreaElement
    )?.value.trim();
    const issueType = (
      row.querySelector(`.ai-lc-issue[data-idx="${idx}"]`) as HTMLInputElement
    )?.value.trim();
    const group =
      (row.querySelector(`.ai-lc-group[data-idx="${idx}"]`) as HTMLSelectElement)?.value || 'Other';
    const severity = (row.querySelector(`.ai-lc-severity[data-idx="${idx}"]`) as HTMLSelectElement)
      ?.value as 'ok' | 'warning' | 'critical';
    const warnThreshold = parseFloat(
      (row.querySelector(`.ai-lc-warn[data-idx="${idx}"]`) as HTMLInputElement)?.value,
    );
    const critThreshold = parseFloat(
      (row.querySelector(`.ai-lc-crit[data-idx="${idx}"]`) as HTMLInputElement)?.value,
    );

    // Allow empty labels only for newly added rows (they'll be filled in)
    configs.push({
      label: label || '',
      issueType: issueType || 'ok',
      severity: severity || 'ok',
      warnThreshold: isNaN(warnThreshold) ? 0.5 : warnThreshold,
      critThreshold: isNaN(critThreshold) ? 0.8 : critThreshold,
      group: group || 'Other',
    });
  }
  return configs;
}
