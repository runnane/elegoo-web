// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ELEG-84. As with `alert-sound.test.ts`, only the decision-and-dispatch half is
 * testable here — whether a real OS notification actually appears needs a browser and a
 * granted permission, which no gate has. What IS testable, and is where the rules that
 * could silently drift live: which events fire one, the secure-context / permission
 * gating, the live-vs-history seam, and that the decision is `alertForEvent` and not a
 * second rule.
 *
 * jsdom implements neither `window.isSecureContext` nor `window.Notification` (both are
 * `undefined`/absent by default — checked directly against jsdom rather than assumed),
 * so every test below stubs both explicitly rather than relying on an environment
 * default that happens to read as secure.
 */

class MockNotification {
  static permission: NotificationPermission = 'default';
  static requestPermission = vi.fn(async () => MockNotification.permission);
  static instances: MockNotification[] = [];
  title: string;
  options?: NotificationOptions;
  constructor(title: string, options?: NotificationOptions) {
    this.title = title;
    this.options = options;
    MockNotification.instances.push(this);
  }
}

function stubSecureContext(secure: boolean): void {
  Object.defineProperty(window, 'isSecureContext', {
    value: secure,
    configurable: true,
    writable: true,
  });
}

function stubNotificationCtor(present: boolean): void {
  if (present) {
    Object.defineProperty(window, 'Notification', {
      value: MockNotification,
      configurable: true,
      writable: true,
    });
  } else {
    Object.defineProperty(window, 'Notification', {
      value: undefined,
      configurable: true,
      writable: true,
    });
  }
}

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  MockNotification.permission = 'default';
  MockNotification.instances = [];
  MockNotification.requestPermission = vi.fn(async () => MockNotification.permission);
  stubSecureContext(true);
  stubNotificationCtor(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('notifySupport', () => {
  it('reports insecure when the context is not secure, regardless of Notification support', async () => {
    stubSecureContext(false);
    const { notifySupport } = await import('../ui/notify-desktop');
    expect(notifySupport()).toBe('insecure');
  });

  it('reports unsupported when Notification is absent in a secure context', async () => {
    stubNotificationCtor(false);
    const { notifySupport } = await import('../ui/notify-desktop');
    expect(notifySupport()).toBe('unsupported');
  });

  it('reports the live permission value when secure and supported', async () => {
    const { notifySupport } = await import('../ui/notify-desktop');

    MockNotification.permission = 'default';
    expect(notifySupport()).toBe('default');

    MockNotification.permission = 'denied';
    expect(notifySupport()).toBe('denied');

    MockNotification.permission = 'granted';
    expect(notifySupport()).toBe('granted');
  });
});

describe('requestNotifyPermission', () => {
  it('calls the browser prompt and returns the granted result', async () => {
    MockNotification.permission = 'granted';
    const { requestNotifyPermission } = await import('../ui/notify-desktop');

    const result = await requestNotifyPermission();

    expect(MockNotification.requestPermission).toHaveBeenCalledTimes(1);
    expect(result).toBe('granted');
  });

  it('does not throw and reports unsupported when Notification is absent', async () => {
    stubNotificationCtor(false);
    const { requestNotifyPermission } = await import('../ui/notify-desktop');

    await expect(requestNotifyPermission()).resolves.toBe('unsupported');
  });

  it('reports insecure without touching Notification at all when the context is not secure', async () => {
    stubSecureContext(false);
    const { requestNotifyPermission } = await import('../ui/notify-desktop');

    const result = await requestNotifyPermission();

    expect(result).toBe('insecure');
    expect(MockNotification.requestPermission).not.toHaveBeenCalled();
  });
});

describe('maybeNotifyForEvent', () => {
  async function enableAndGrant() {
    const { saveUISettings } = await import('../ui/ui-settings');
    saveUISettings({ notifyDesktop: true });
    MockNotification.permission = 'granted';
  }

  it('fires a notification for a live print-completed event when enabled and granted', async () => {
    await enableAndGrant();
    const { maybeNotifyForEvent } = await import('../ui/notify-desktop');

    maybeNotifyForEvent({ type: 'print_completed', filename: 'a.gcode' });

    expect(MockNotification.instances).toHaveLength(1);
    expect(MockNotification.instances[0].title).toBe('Print completed');
  });

  it('fires a notification for a live critical-error event when enabled and granted', async () => {
    await enableAndGrant();
    const { maybeNotifyForEvent } = await import('../ui/notify-desktop');
    const { CRITICAL_EXCEPTIONS } = await import('../types');
    const code = [...CRITICAL_EXCEPTIONS][0];

    maybeNotifyForEvent({ type: 'error', codes: [code], names: ['x'] });

    expect(MockNotification.instances).toHaveLength(1);
    expect(MockNotification.instances[0].title).toBe('Print needs attention');
  });

  it('sets a fixed tag, so a repeat replaces rather than stacks', async () => {
    await enableAndGrant();
    const { maybeNotifyForEvent } = await import('../ui/notify-desktop');

    maybeNotifyForEvent({ type: 'print_completed', filename: 'a.gcode' });
    maybeNotifyForEvent({ type: 'print_failed', filename: 'b.gcode', reason: 'x' });

    expect(MockNotification.instances).toHaveLength(2);
    const tags = MockNotification.instances.map((n) => n.options?.tag);
    expect(tags[0]).toBe(tags[1]);
    expect(tags[0]).toBeTruthy();
  });

  it('does not fire when the setting is off, even if permission is granted', async () => {
    MockNotification.permission = 'granted';
    const { maybeNotifyForEvent } = await import('../ui/notify-desktop');

    maybeNotifyForEvent({ type: 'print_completed', filename: 'a.gcode' });

    expect(MockNotification.instances).toHaveLength(0);
  });

  it('does not fire when permission is denied, even if the setting is on', async () => {
    const { saveUISettings } = await import('../ui/ui-settings');
    saveUISettings({ notifyDesktop: true });
    MockNotification.permission = 'denied';
    const { maybeNotifyForEvent } = await import('../ui/notify-desktop');

    maybeNotifyForEvent({ type: 'print_completed', filename: 'a.gcode' });

    expect(MockNotification.instances).toHaveLength(0);
  });

  it('does not fire in an insecure context, even if the setting is on', async () => {
    const { saveUISettings } = await import('../ui/ui-settings');
    saveUISettings({ notifyDesktop: true });
    MockNotification.permission = 'granted';
    stubSecureContext(false);
    const { maybeNotifyForEvent } = await import('../ui/notify-desktop');

    maybeNotifyForEvent({ type: 'print_completed', filename: 'a.gcode' });

    expect(MockNotification.instances).toHaveLength(0);
  });

  it('stays silent for a routine event the same way the audible alert does', async () => {
    await enableAndGrant();
    const { maybeNotifyForEvent } = await import('../ui/notify-desktop');

    maybeNotifyForEvent({ type: 'print_progress', percent: 42 });

    expect(MockNotification.instances).toHaveLength(0);
  });

  it('uses alertForEvent as the decision, not a second rule', async () => {
    // Mock the pure decision function itself and assert maybeNotifyForEvent calls
    // through to it — proving the notification path has no independent opinion about
    // which events matter. A mutation to the real `alertForEvent` therefore changes
    // both the sound and the notification path, because both import the same function.
    vi.doMock('../ui/alert-sound', () => ({
      alertForEvent: vi.fn(() => 'success'),
    }));
    await enableAndGrant();
    const { maybeNotifyForEvent } = await import('../ui/notify-desktop');
    const { alertForEvent } = await import('../ui/alert-sound');

    maybeNotifyForEvent({ type: 'something_new_and_unmapped' });

    expect(alertForEvent).toHaveBeenCalledWith({ type: 'something_new_and_unmapped' });
    // The mocked decision said 'success', so a notification fires even for an event
    // `alertForEvent`'s real implementation would ignore — proof the kind comes from
    // the imported function, not from re-inspecting the event locally.
    expect(MockNotification.instances).toHaveLength(1);
    vi.doUnmock('../ui/alert-sound');
  });
});
