// @vitest-environment jsdom
/**
 * ELEG-168: the panel and the status pill must say the monitor is not analysing.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { degradedMessage, renderAIPanel, updateAIStatus } from '../ui/ai-panel';
import { indicatorState } from '../ui/service-status';

const CONFIG = { intervalSec: 10, vlmEnabled: false, localEnabled: false };

describe('degradedMessage', () => {
  it('names the reason, since when, and the last analysis', () => {
    const since = new Date(2026, 10, 26, 13, 5).getTime();
    const last = new Date(2026, 10, 26, 13, 4).getTime();
    const msg = degradedMessage({ reason: 'camera unavailable', since, lastAnalysisAt: last });
    expect(msg).toMatch(/^Not analysing — camera unavailable since /);
    expect(msg).toContain('last analysed');
    expect(msg).not.toContain('nothing analysed yet');
  });

  it('says so when nothing has ever been analysed', () => {
    expect(degradedMessage({ reason: 'x', since: Date.now(), lastAnalysisAt: null })).toContain(
      'nothing analysed yet',
    );
  });
});

describe('AI panel and status pill', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="ai-panel"></div>';
  });

  it('shows "Not analysing" instead of "Monitoring active" when degraded', () => {
    updateAIStatus('degraded', {
      ...CONFIG,
      health: { state: 'degraded', reason: 'camera unavailable', since: Date.now() },
    });
    const line = document.querySelector('.ai-status-line')?.textContent ?? '';
    expect(line).toContain('Not analysing');
    expect(line).not.toContain('Monitoring active');
  });

  it('shows "Monitoring active" when monitoring normally', () => {
    updateAIStatus('monitoring', CONFIG);
    renderAIPanel();
    expect(document.querySelector('.ai-status-line')?.textContent).toContain('Monitoring active');
  });

  it('the service-status AI row reads degraded as unavailable, not OK', () => {
    expect(indicatorState('degraded', ['monitoring', 'idle'])).toBe('err');
    expect(indicatorState('monitoring', ['monitoring', 'idle'])).toBe('ok');
  });
});
