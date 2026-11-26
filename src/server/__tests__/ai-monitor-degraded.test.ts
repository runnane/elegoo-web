/**
 * ELEG-168: the AI monitor must not say it is monitoring while it has no frames.
 *
 * A fake frame source stands in for the camera, so no network and no printer are touched
 * and no analyser runs (local CLIP and VLM are both off in the fake config — nothing can
 * reach a real model or send a message). The store is a bare EventEmitter carrying only
 * the two fields `runAnalysis` reads.
 */

import { EventEmitter } from 'events';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AIMonitor, DEGRADED_AFTER_FAILURES, type FrameSource } from '../ai-monitor.js';
import type { ServiceConfig } from '../config.js';
import type { StateStore } from '../state-store.js';

const config = {
  cameraEnabled: true,
  aiIntervalSec: 10,
  aiLocalEnabled: false,
  aiVlmEnabled: false,
  aiAlertThreshold: 3,
  aiAlertCooldownSec: 300,
  aiLocalModel: 'unused',
  dataDir: '/nonexistent-eleg-168',
} as unknown as ServiceConfig;

function fakeStore(): StateStore {
  const store = new EventEmitter() as EventEmitter & Record<string, unknown>;
  store.status = { machine_status: { sub_status: 2075 } };
  store.zones = { current: 'print_area' };
  return store as unknown as StateStore;
}

let frame: Buffer;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearInterval', 'Date'] });
  frame = await sharp({
    create: { width: 32, height: 24, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .jpeg()
    .toBuffer();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function startedMonitor(source: FrameSource): AIMonitor {
  const store = fakeStore();
  const monitor = new AIMonitor(store, config, source);
  store.emit('print_event', { type: 'print_started' });
  return monitor;
}

describe('AI monitor degraded state (ELEG-168)', () => {
  it('goes degraded after N failed intervals, with a reason and since-when', async () => {
    const monitor = startedMonitor(async () => null);
    const degraded = vi.fn();
    monitor.on('degraded', degraded);
    const t0 = Date.now();

    for (let i = 0; i < DEGRADED_AFTER_FAILURES - 1; i++) {
      await monitor.runAnalysis();
      vi.setSystemTime(Date.now() + 10_000);
    }
    // Not yet: below the threshold the monitor still reads as monitoring.
    expect(monitor.getHealth().state).toBe('ok');
    expect(monitor.statusValue).toBe('monitoring');
    expect(degraded).not.toHaveBeenCalled();

    await monitor.runAnalysis();

    const health = monitor.getHealth();
    expect(health.state).toBe('degraded');
    expect(health.reason).toContain('camera unavailable');
    expect(health.since).toBe(t0);
    expect(health.lastAnalysisAt).toBeNull();
    // The service-status mapping: `degraded`, not `monitoring`.
    expect(monitor.statusValue).toBe('degraded');
    expect(monitor.getConfigSummary().health).toMatchObject({ state: 'degraded' });
  });

  it('emits `degraded` once per episode, not once per failed interval', async () => {
    const monitor = startedMonitor(async () => null);
    const degraded = vi.fn();
    monitor.on('degraded', degraded);
    for (let i = 0; i < DEGRADED_AFTER_FAILURES + 4; i++) await monitor.runAnalysis();
    expect(degraded).toHaveBeenCalledTimes(1);
  });

  it('treats a throwing frame source as a fetch error', async () => {
    const monitor = startedMonitor(async () => {
      throw new Error('socket hang up');
    });
    for (let i = 0; i < DEGRADED_AFTER_FAILURES; i++) await monitor.runAnalysis();
    expect(monitor.statusValue).toBe('degraded');
    expect(monitor.getHealth().reason).toContain('socket hang up');
  });

  it('recovers to active when frames return, and records the last analysis', async () => {
    let up = false;
    const monitor = startedMonitor(async () => (up ? frame : null));
    const recovered = vi.fn();
    monitor.on('recovered', recovered);
    for (let i = 0; i < DEGRADED_AFTER_FAILURES; i++) await monitor.runAnalysis();
    expect(monitor.statusValue).toBe('degraded');

    up = true;
    vi.setSystemTime(Date.now() + 10_000);
    await monitor.runAnalysis();

    expect(monitor.statusValue).toBe('monitoring');
    const health = monitor.getHealth();
    expect(health).toMatchObject({ state: 'ok', reason: null, since: null });
    expect(health.lastAnalysisAt).toBe(Date.now());
    expect(recovered).toHaveBeenCalledTimes(1);
  });

  it('a single good frame resets the failure run', async () => {
    let up = false;
    const monitor = startedMonitor(async () => (up ? frame : null));
    for (let i = 0; i < DEGRADED_AFTER_FAILURES - 1; i++) await monitor.runAnalysis();
    up = true;
    await monitor.runAnalysis();
    up = false;
    for (let i = 0; i < DEGRADED_AFTER_FAILURES - 1; i++) await monitor.runAnalysis();
    expect(monitor.statusValue).toBe('monitoring');
  });
});
