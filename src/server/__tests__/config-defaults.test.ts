import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';

/**
 * Defaults, which are the part of `config.ts` a user actually meets (ELEG-72).
 *
 * `.agents/testing.md` names this module as a high-value target with no coverage. The
 * reason it earned a test now: two of its defaults were wrong in a way that only showed
 * up once the Docker image went public, because the production `.env` sets every AI key
 * explicitly and so the defaults were never exercised on the one install anyone looks at.
 *
 * `loadConfig()` reads `process.env` directly, so these tests swap it out wholesale
 * rather than mutating keys — a stray value inherited from the developer's shell would
 * otherwise make them pass or fail for reasons unrelated to the code.
 */

const ORIGINAL = process.env;

beforeEach(() => {
  // A minimal environment: only what loadConfig() refuses to start without.
  process.env = { PRINTER_IP: '192.0.2.10' } as NodeJS.ProcessEnv;
});

afterEach(() => {
  process.env = ORIGINAL;
});

describe('AI defaults', () => {
  it('leaves AI off entirely unless asked', () => {
    expect(loadConfig().aiEnabled).toBe(false);
  });

  it('does NOT enable VLM just because AI is enabled', () => {
    // The regression. `AI_ENABLED=true` is how the README says to turn on monitoring;
    // it used to switch the VLM on as well, which starts POSTing camera frames to a
    // remote endpoint the user never configured.
    process.env.AI_ENABLED = 'true';
    const config = loadConfig();
    expect(config.aiEnabled).toBe(true);
    expect(config.aiVlmEnabled).toBe(false);
  });

  it('still enables VLM when explicitly asked', () => {
    process.env.AI_ENABLED = 'true';
    process.env.AI_VLM_ENABLED = 'true';
    expect(loadConfig().aiVlmEnabled).toBe(true);
  });

  it('never defaults any endpoint to a private network address', () => {
    // This shipped in a public image: the default pointed at a hardcoded address on the
    // maintainer's own LAN, so every user who enabled AI sent pictures of their printer
    // to whatever happened to hold that IP on THEIR network. Asserted as a pattern
    // rather than an equality so any future private-range default is caught too.
    const { aiVlmBaseUrl } = loadConfig();
    expect(aiVlmBaseUrl).not.toMatch(/\/\/(10|127\.[^0]|172\.(1[6-9]|2\d|3[01])|192\.168)\./);
    expect(aiVlmBaseUrl).toContain('localhost');
  });

  it('defaults to the port ollama actually listens on', () => {
    // The old default was :3000, which could not have worked against a stock ollama
    // even on the right host — so the feature was broken as well as misdirected.
    expect(loadConfig().aiVlmProvider).toBe('ollama');
    expect(loadConfig().aiVlmBaseUrl).toContain('11434');
  });

  it('keeps the local CLIP analyzer opt-out rather than opt-in', () => {
    // Deliberately unchanged: the local model runs in-process and sends nothing
    // anywhere, so defaulting it on is not the same decision as the VLM.
    expect(loadConfig().aiLocalEnabled).toBe(true);
  });
});

describe('PRINTER_IP validation', () => {
  it('refuses a malformed address rather than starting and failing later', () => {
    process.env.PRINTER_IP = 'not-an-ip';
    expect(() => loadConfig()).toThrow(/PRINTER_IP/);
  });
});
