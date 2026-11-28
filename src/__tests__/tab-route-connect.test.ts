// @vitest-environment jsdom
/**
 * ELEG-198 — a `#settings` deep link must not get the dashboard rendered under it when the
 * service answers. Uses the real `switchToTab` so "switching back still shows it" is covered.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { switchToTab } from '../ui/settings';
import { revealDashboardIfActive } from '../ui/tab-route';

function mountLayout(): void {
  document.body.innerHTML = `
    <nav>
      <button class="main-tab active" data-tab="dashboard">Dashboard</button>
      <button class="main-tab" data-tab="settings">Settings</button>
    </nav>
    <div id="connect-dialog"></div>
    <div id="dashboard" class="hidden"></div>
    <div id="settings-tab-content" class="hidden"><div id="settings-content"></div></div>
  `;
}

const dashboard = (): HTMLElement => document.getElementById('dashboard') as HTMLElement;

describe('revealDashboardIfActive', () => {
  beforeEach(mountLayout);

  it('keeps the dashboard hidden under a deep-linked #settings page', () => {
    window.location.hash = '#settings';
    switchToTab('settings'); // what initTabRoute does on load
    revealDashboardIfActive(dashboard(), window.location.hash);
    expect(dashboard().classList.contains('hidden')).toBe(true);
    expect(dashboard().dataset.connected).toBe('true');
    expect(document.getElementById('settings-tab-content')?.classList.contains('hidden')).toBe(
      false,
    );
  });

  it('shows the dashboard again when switching back to it', () => {
    window.location.hash = '#settings';
    switchToTab('settings');
    revealDashboardIfActive(dashboard(), window.location.hash);
    switchToTab('dashboard');
    expect(dashboard().classList.contains('hidden')).toBe(false);
  });

  it('shows the dashboard with no hash', () => {
    window.location.hash = '';
    revealDashboardIfActive(dashboard(), window.location.hash);
    expect(dashboard().classList.contains('hidden')).toBe(false);
    expect(dashboard().dataset.connected).toBe('true');
  });

  it('shows the dashboard for an unknown hash', () => {
    revealDashboardIfActive(dashboard(), '#nonsense');
    expect(dashboard().classList.contains('hidden')).toBe(false);
  });
});
