// @vitest-environment jsdom
/**
 * ELEG-175 — the active tab lives in `location.hash`.
 *
 * Uses the real `switchToTab` (the one path clicks and shortcuts share), so a test going
 * red means the URL and the visible tab have come apart.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { switchToTab } from '../ui/settings';
import { initTabRoute, parseTabHash, tabHash } from '../ui/tab-route';

function mountLayout(): void {
  document.body.innerHTML = `
    <nav>
      <button class="main-tab active" data-tab="dashboard">Dashboard</button>
      <button class="main-tab" data-tab="tools">Tools</button>
      <button class="main-tab" data-tab="settings">Settings</button>
      <button class="main-tab" data-tab="debug">Debug</button>
      <button class="main-tab" data-tab="help">Help</button>
    </nav>
    <div id="connect-dialog" class="hidden"></div>
    <div id="dashboard" data-connected="true"></div>
    <div id="settings-tab-content" class="hidden"><div id="settings-content"></div></div>
    <div id="tools-tab-content" class="hidden"></div>
    <div id="help-tab-content" class="hidden"><div id="help-content"></div></div>
    <div id="debug-tab-content" class="hidden"></div>
  `;
}

function activeTab(): string | undefined {
  return (document.querySelector('.main-tab.active') as HTMLElement | null)?.dataset.tab;
}

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe('parseTabHash / tabHash', () => {
  it('maps known hashes to tabs, case-insensitively', () => {
    expect(parseTabHash('#help')).toBe('help');
    expect(parseTabHash('#Settings')).toBe('settings');
    expect(parseTabHash('#tools')).toBe('tools');
    expect(parseTabHash('#debug')).toBe('debug');
  });
  it('maps empty and unknown hashes to dashboard', () => {
    expect(parseTabHash('')).toBe('dashboard');
    expect(parseTabHash('#')).toBe('dashboard');
    expect(parseTabHash('#nonsense')).toBe('dashboard');
  });
  it('formats the dashboard as no hash', () => {
    expect(tabHash('dashboard')).toBe('');
    expect(tabHash('help')).toBe('#help');
  });
});

describe('tab route in the DOM', () => {
  beforeAll(() => {
    mountLayout();
    // Bound once, as the app does on page load; the hash is empty here.
    initTabRoute(switchToTab);
  });
  beforeEach(async () => {
    window.location.hash = '';
    await tick();
    switchToTab('dashboard');
  });

  it('opens the tab named by the hash on load', () => {
    window.location.hash = '#help';
    // A fresh load: initTabRoute reads the hash once and switches.
    const switched: string[] = [];
    initTabRoute((t) => switched.push(t));
    expect(switched).toEqual(['help']);
  });

  it('keeps the dashboard for an unknown hash on load', () => {
    window.location.hash = '#nonsense';
    const switched: string[] = [];
    initTabRoute((t) => switched.push(t));
    expect(switched).toEqual([]);
    switchToTab(parseTabHash(window.location.hash));
    expect(activeTab()).toBe('dashboard');
  });

  it('sets the hash when a tab is switched, and clears it for the dashboard', () => {
    switchToTab('settings');
    expect(window.location.hash).toBe('#settings');
    switchToTab('dashboard');
    expect(window.location.hash).toBe('');
  });

  it('does not push a history entry when the hash already matches', () => {
    switchToTab('help');
    const before = window.history.length;
    switchToTab('help');
    expect(window.history.length).toBe(before);
  });

  it('switches the tab on hashchange', async () => {
    window.location.hash = '#tools';
    await tick();
    expect(activeTab()).toBe('tools');
    expect(document.getElementById('tools-tab-content')?.classList.contains('hidden')).toBe(false);
  });

  it('falls back to the dashboard when the hash becomes unknown', async () => {
    switchToTab('help');
    window.location.hash = '#nonsense';
    await tick();
    expect(activeTab()).toBe('dashboard');
  });

  it('moves between tabs with Back', async () => {
    switchToTab('tools');
    switchToTab('settings');
    window.history.back();
    await tick();
    await tick();
    expect(window.location.hash).toBe('#tools');
    expect(activeTab()).toBe('tools');
  });
});
