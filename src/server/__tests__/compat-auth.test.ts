import { describe, it, expect } from 'vitest';
import {
  octoprintApiSettings,
  octoprintLoginPayload,
  NO_API_KEY_MESSAGE,
  NO_SESSIONS_MESSAGE,
  ONESHOT_TOKEN,
  MOONRAKER_NO_API_KEY_CODE,
} from '../compat-auth.js';

/**
 * The compat layers are pure state→JSON translation, and a client breaks silently when
 * a field's shape drifts. These assert the emitted shape directly — no printer, no
 * network — which is what ELEG-26 asked for.
 */

describe('octoprintApiSettings', () => {
  it('reports API-key auth as disabled', () => {
    expect(octoprintApiSettings()).toEqual({ enabled: false, key: null });
  });

  it('never emits a key', () => {
    // The regression this exists to catch: a fixed string that made clients show
    // themselves as authenticated against a service that checks nothing.
    expect(octoprintApiSettings().key).toBeNull();
  });
});

describe('octoprintLoginPayload', () => {
  const payload = octoprintLoginPayload();

  it('carries no apikey field at all', () => {
    expect('apikey' in payload).toBe(false);
  });

  it('claims no login mechanism', () => {
    expect(payload._login_mechanism).toBeNull();
  });

  it('still reports full control, because that is true', () => {
    // With no authentication every caller does have admin capability. Understating it
    // would be its own dishonesty — the exposure is the point of ELEG-2.
    expect(payload.admin).toBe(true);
    expect(payload.user).toBe(true);
    expect(payload.active).toBe(true);
  });

  it('keeps the fields OctoPrint clients read, so the shape stays usable', () => {
    for (const key of ['name', 'groups', 'roles', 'permissions', 'needs']) {
      expect(payload, `missing ${key}`).toHaveProperty(key);
    }
  });

  it('mentions no credential anywhere in the serialised body', () => {
    // Belt and braces: catches a credential reintroduced under a different field name.
    expect(JSON.stringify(payload)).not.toMatch(/elegoo-cc2-compat|apikey|api_key/i);
  });
});

describe('the no-API-key answer', () => {
  it('explains itself rather than returning an empty string', () => {
    expect(NO_API_KEY_MESSAGE).toMatch(/no authentication/i);
    expect(NO_API_KEY_MESSAGE.length).toBeGreaterThan(20);
  });

  it('uses a JSON-RPC error code, not a success code', () => {
    expect(MOONRAKER_NO_API_KEY_CODE).toBeLessThan(0);
  });
});

describe('the no-sessions answer (ELEG-53)', () => {
  it('explains itself, and points at the field that says login is unnecessary', () => {
    // A client's UI shows this string. "Unauthorized" would send someone hunting for a
    // password that does not exist; naming access.info tells them where to look instead.
    expect(NO_SESSIONS_MESSAGE).toMatch(/no authentication/i);
    expect(NO_SESSIONS_MESSAGE).toMatch(/login_required/);
    expect(NO_SESSIONS_MESSAGE.length).toBeGreaterThan(20);
  });

  it('mentions no credential and no user account', () => {
    // The regression this exists to catch, in the shape ELEG-26 used for the API key:
    // a token reintroduced under any name at all.
    expect(NO_SESSIONS_MESSAGE).not.toMatch(/elegoo-compat/i);
    expect(NO_SESSIONS_MESSAGE).toMatch(/issues no tokens/i);
  });
});

describe('the oneshot token, which is deliberately still issued', () => {
  it('is a non-empty string, because withdrawing it could break the WebSocket', () => {
    // Real Moonraker uses this where a header cannot be set (WebSocket, camera stream),
    // and a client may fetch one BEFORE reading access.info. Refusing it would be a
    // regression, not a security improvement — nothing validates it either way.
    expect(typeof ONESHOT_TOKEN).toBe('string');
    expect(ONESHOT_TOKEN.length).toBeGreaterThan(0);
  });

  it('does not read like a credential when it shows up in a URL or a log', () => {
    // It lands in query strings, proxy logs and browser network tabs. Anyone who sees it
    // should be able to tell at a glance that nothing is being authenticated.
    expect(ONESHOT_TOKEN).not.toMatch(/token|key|secret|jwt|auth[^-]/i);
    expect(ONESHOT_TOKEN).toBe('no-auth-required');
  });
});
