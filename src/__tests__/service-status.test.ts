// @vitest-environment jsdom
/**
 * ELEG-130 (WCAG 1.4.1): a service's state must not be conveyed by dot colour alone.
 * The pure half pins the state -> glyph/label mapping; the DOM half renders the real card
 * and checks every indicator carries a non-empty accessible name and a distinct glyph.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type IndicatorState,
  indicatorCue,
  indicatorState,
  updateServiceStatus,
} from '../ui/service-status';

const STATES: IndicatorState[] = ['ok', 'err', 'disabled'];

describe('indicatorCue', () => {
  it('pins glyph and label for every state', () => {
    expect(indicatorCue('ok')).toEqual({ glyph: '✓', label: 'OK' });
    expect(indicatorCue('err')).toEqual({ glyph: '✕', label: 'Unavailable' });
    expect(indicatorCue('disabled')).toEqual({ glyph: '–', label: 'Disabled' });
  });

  it('gives every state a distinct glyph and a distinct label', () => {
    const cues = STATES.map(indicatorCue);
    expect(new Set(cues.map((c) => c.glyph)).size).toBe(STATES.length);
    expect(new Set(cues.map((c) => c.label)).size).toBe(STATES.length);
  });
});

describe('indicatorState', () => {
  it('maps reported values to states', () => {
    expect(indicatorState('running', ['running'])).toBe('ok');
    expect(indicatorState('disabled', ['running'])).toBe('disabled');
    expect(indicatorState('stopped', ['running'])).toBe('err');
  });
});

function setupDom(): void {
  document.body.innerHTML = `
    <div id="svc-header-wrap">
      <button id="svc-header-badge"><span id="svc-header-dots"></span><span id="svc-header-count"></span></button>
      <div id="svc-dropdown" class="hidden"><div id="service-status"></div></div>
    </div>`;
}

const BASE = {
  uptime: 100,
  mqtt: 'connected',
  mqttRegisterAttempts: 0,
  printerSn: 'SN',
  printerIp: '192.0.2.1',
  wsClients: 1,
  telegram: 'disabled',
  ai: 'idle',
  camera: 'unavailable',
};

describe('service status card markup', () => {
  beforeEach(setupDom);

  it('every indicator has an accessible name and ok/err/disabled differ by glyph', () => {
    updateServiceStatus(BASE);
    const dots = [
      ...document.querySelectorAll('#svc-header-dots .status-dot'),
      ...document.querySelectorAll('#service-status .status-dot'),
    ];
    expect(dots.length).toBeGreaterThan(5);
    for (const d of dots) {
      expect(d.getAttribute('role')).toBe('img');
      expect((d.getAttribute('aria-label') ?? '').trim()).not.toBe('');
      expect(d.getAttribute('title')).toBe(d.getAttribute('aria-label'));
      expect((d.textContent ?? '').trim()).not.toBe('');
    }
    const glyphOf = (name: string) =>
      document
        .querySelector(`#svc-header-dots .status-dot[aria-label^="${name}:"]`)
        ?.textContent?.trim();
    const ok = glyphOf('MQTT');
    const err = glyphOf('Camera');
    const off = glyphOf('Telegram');
    expect(ok).toBeTruthy();
    expect(new Set([ok, err, off]).size).toBe(3);
  });

  it('dropdown rows show the state as text', () => {
    updateServiceStatus(BASE);
    const text = document.querySelector('#service-status')?.textContent ?? '';
    expect(text).toContain('Unavailable');
    expect(text).toContain('Disabled');
    expect(text).toContain('OK');
  });
});
