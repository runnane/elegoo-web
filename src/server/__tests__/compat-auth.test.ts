import { describe, it, expect } from 'vitest';
import {
  octoprintApiSettings,
  octoprintLoginPayload,
  NO_API_KEY_MESSAGE,
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
