// @vitest-environment jsdom
/**
 * The MQTT phase as a human actually sees it (ELEG-59), using the jsdom environment
 * ELEG-61 added. See `list-controls-dom.test.ts` for the conventions.
 *
 * The pure decisions — which phase, whether to warn — are tested in `types.test.ts`.
 * What is asserted here is the wiring: that the phase reaches the badge and the banner,
 * that the two previously-indistinguishable states now read differently on the page, and
 * that a browser holding a pre-ELEG-59 payload still renders something sensible.
 *
 * This is the layer where the incident actually happened: the classifier could have been
 * perfect and it would still have cost a journal read if the page kept saying
 * `registering…`.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { type ServiceStatus, updateServiceStatus } from '../ui/service-status';

/** The ids `renderServiceStatus` looks up, and nothing more. */
function mountShell() {
  document.body.innerHTML = `
    <div id="svc-header-wrap">
      <div id="svc-header-badge"><span id="svc-header-dots"></span><span id="svc-header-count"></span></div>
      <div id="svc-dropdown" class="hidden"><div id="service-status"></div></div>
    </div>`;
  return document.querySelector('#service-status') as HTMLElement;
}

const BASE: ServiceStatus = {
  uptime: 120,
  mqtt: 'broker_only',
  mqttRegisterAttempts: 0,
  printerSn: null,
  printerIp: '192.0.2.10',
  wsClients: 1,
  telegram: 'disabled',
  ai: 'disabled',
  camera: 'available',
};

const render = (over: Partial<ServiceStatus>) =>
  updateServiceStatus({ ...BASE, ...over } as unknown as Record<string, unknown>);

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('the two broker_only states no longer look identical', () => {
  it('says the printer is not responding when no SN was ever discovered', () => {
    const panel = mountShell();
    render({ mqttPhase: 'awaiting_sn', mqttRegisterAttempts: 0 });

    // The incident: registration was never even attempted, so attempts is 0.
    expect(panel.textContent).toContain('waiting for printer');
    expect(panel.textContent).toContain('Printer not responding');
    expect(panel.textContent).toMatch(/power cycle/i);
    // And crucially it must NOT claim to be registering, which is what sent the
    // 2026-08-08 diagnosis at the service instead of at the printer.
    expect(panel.textContent).not.toContain('registering...');
  });

  it('says the registration was refused, and why, when the printer said code 3', () => {
    const panel = mountShell();
    render({ mqttPhase: 'rejected', mqttRegisterAttempts: 4 });

    expect(panel.textContent).toContain('refused');
    expect(panel.textContent).toContain('Registration refused');
    expect(panel.textContent).toMatch(/two clients/i);
  });

  it('renders the two phases differently — the whole point of the change', () => {
    const panel = mountShell();
    render({ mqttPhase: 'awaiting_sn' });
    const awaiting = panel.textContent ?? '';
    render({ mqttPhase: 'rejected' });
    const rejected = panel.textContent ?? '';

    expect(awaiting).not.toBe(rejected);
  });
});

describe('the banner threshold', () => {
  it('stays quiet during a normal young registration', () => {
    const panel = mountShell();
    render({ mqttPhase: 'registering', mqttRegisterAttempts: 1 });

    expect(panel.textContent).toContain('registering...');
    expect(panel.querySelector('.svc-firmware-warning')).toBeNull();
  });

  it('warns once registration has been retried enough to be a problem', () => {
    const panel = mountShell();
    render({ mqttPhase: 'registering', mqttRegisterAttempts: 7 });

    expect(panel.querySelector('.svc-firmware-warning')).not.toBeNull();
    expect(panel.textContent).toContain('7 registration attempts');
  });

  it('shows no banner at all when connected', () => {
    const panel = mountShell();
    render({ mqtt: 'connected', mqttPhase: 'connected', printerSn: 'ABC123' });

    expect(panel.querySelector('.svc-firmware-warning')).toBeNull();
    expect(panel.textContent).toContain('connected');
  });
});

describe('a browser holding a payload from before this shipped', () => {
  it('falls back to the coarse mqtt field rather than rendering undefined', () => {
    const panel = mountShell();
    // No mqttPhase key at all — exactly what an old server sends.
    render({ mqttPhase: undefined, mqtt: 'broker_only', mqttRegisterAttempts: 0 });

    expect(panel.textContent).toContain('registering...');
    expect(panel.textContent).not.toContain('undefined');
  });

  it('still reports a plain disconnect', () => {
    const panel = mountShell();
    render({ mqttPhase: undefined, mqtt: 'disconnected' });

    expect(panel.textContent).toContain('disconnected');
    expect(panel.querySelector('.svc-firmware-warning')).toBeNull();
  });
});

describe('the running version in the panel (ELEG-48)', () => {
  it('renders x.y.z+aa from the deploy stamp', () => {
    const panel = mountShell();
    render({
      mqtt: 'connected',
      mqttPhase: 'connected',
      build: { describe: 'v0.2.1-58-g5b00442', version: '0.2.1' },
    });

    expect(panel.textContent).toContain('Version');
    expect(panel.textContent).toContain('0.2.1+58');
  });

  it('says "unknown" on an unstamped build, and never renders null', () => {
    // Normal for `pnpm dev`, and for a deploy where the installer never re-ran. The
    // issue is explicit that this must not render `null+null`.
    const panel = mountShell();
    render({ mqtt: 'connected', mqttPhase: 'connected', build: null });

    expect(panel.textContent).toContain('unknown');
    expect(panel.textContent).not.toContain('null');
  });

  it('marks an unstamped build as not-ok, because it is a real gap', () => {
    const panel = mountShell();
    render({ mqtt: 'connected', mqttPhase: 'connected', build: null });
    const rows = [...panel.querySelectorAll('.svc-item')];
    const versionRow = rows.find((r) => r.textContent?.includes('Version'));
    expect(versionRow?.querySelector('.status-dot-err')).not.toBeNull();
  });

  it('marks a stamped build ok', () => {
    const panel = mountShell();
    render({ mqtt: 'connected', mqttPhase: 'connected', build: { describe: 'v0.3.0' } });
    const rows = [...panel.querySelectorAll('.svc-item')];
    const versionRow = rows.find((r) => r.textContent?.includes('Version'));
    expect(versionRow?.querySelector('.status-dot-ok')).not.toBeNull();
    expect(versionRow?.textContent).toContain('0.3.0');
  });

  it('survives a browser holding a payload from before this shipped', () => {
    const panel = mountShell();
    render({ mqtt: 'connected', mqttPhase: 'connected', build: undefined });
    expect(panel.textContent).toContain('unknown');
  });
});
