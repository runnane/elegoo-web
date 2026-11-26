/**
 * ELEG-174 — the dashboard's text: temperatures, the status badge, the header subtitle
 * and the toolhead speed. All pure, from `ui/dashboard-format.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  formatTemperature,
  formatToolheadSpeed,
  printerSubtitle,
  statusBadge,
  subStatusSuffix,
} from '../ui/dashboard-format';

describe('formatTemperature', () => {
  it('shows a whole-degree reading without decimals', () => {
    expect(formatTemperature(210)).toBe('210');
    expect(formatTemperature(60)).toBe('60');
    expect(formatTemperature(25)).toBe('25');
    expect(formatTemperature(0)).toBe('0');
  });

  it('shows a fractional reading with one decimal', () => {
    expect(formatTemperature(209.46)).toBe('209.5');
    expect(formatTemperature(24.3)).toBe('24.3');
  });

  it('drops the decimal when the reading rounds to a whole degree', () => {
    expect(formatTemperature(59.98)).toBe('60');
  });

  it('shows a placeholder for a reading that is not a number', () => {
    expect(formatTemperature(Number.NaN)).toBe('--');
  });
});

describe('subStatusSuffix', () => {
  it('omits a sub-status that repeats the shown word', () => {
    expect(subStatusSuffix('Printing', 'Printing')).toBe('');
    expect(subStatusSuffix('Paused', 'paused')).toBe('');
  });

  it('keeps a sub-status that says something new', () => {
    expect(subStatusSuffix('Printing', 'Preheating Nozzle')).toBe(' · Preheating Nozzle');
  });

  it('is empty without a sub-status', () => {
    expect(subStatusSuffix('Idle', '')).toBe('');
    expect(subStatusSuffix('Idle', undefined)).toBe('');
  });
});

describe('statusBadge', () => {
  it('printing with sub-status 2075 reads once, not "Printing · Printing"', () => {
    expect(statusBadge(2, 2075)).toEqual({ text: '⟳ Printing', className: 'badge-printing' });
  });

  it('paused with sub-status 2502 reads once', () => {
    expect(statusBadge(2, 2502)).toEqual({ text: '⏸ Paused', className: 'badge-paused' });
  });

  it('auto leveling with sub-status 2901 reads once', () => {
    expect(statusBadge(5, 2901).text).toBe('📐 Auto Leveling');
  });

  it('homing with sub-status 2801 reads once', () => {
    expect(statusBadge(10, 2801)).toEqual({ text: 'Homing', className: 'badge-idle' });
  });

  it('still shows a sub-status that adds information', () => {
    expect(statusBadge(2, 1045).text).toBe('⟳ Printing · Preheating Nozzle');
  });

  it('keeps the power-loss and emergency-stop states', () => {
    expect(statusBadge(15, 0)).toEqual({
      text: '⚡ Power loss — resume or cancel',
      className: 'badge-error',
    });
    expect(statusBadge(14, 0)).toEqual({ text: '🛑 Emergency Stop', className: 'badge-error' });
  });

  it('idle with no sub-status is just the status', () => {
    expect(statusBadge(1, 0)).toEqual({ text: 'Idle', className: 'badge-idle' });
  });
});

describe('printerSubtitle', () => {
  it('drops the model when the hostname already contains it (the CC2 default)', () => {
    expect(printerSubtitle('Elegoo Centauri Carbon 2', 'Centauri Carbon 2', '01.03.02.48')).toBe(
      'Elegoo Centauri Carbon 2 — FW 01.03.02.48',
    );
  });

  it('keeps the model for a renamed printer', () => {
    expect(printerSubtitle('Workshop', 'Centauri Carbon 2', '1.0')).toBe(
      'Workshop (Centauri Carbon 2) — FW 1.0',
    );
  });

  it('does not print "FW undefined" when the firmware is unknown', () => {
    expect(printerSubtitle('Workshop', 'Centauri Carbon 2', undefined)).toBe(
      'Workshop (Centauri Carbon 2)',
    );
  });

  it('falls back to the model when there is no hostname', () => {
    expect(printerSubtitle('', 'Centauri Carbon 2', '1.0')).toBe('Centauri Carbon 2 — FW 1.0');
  });
});

describe('formatToolheadSpeed', () => {
  it('converts the mm/min feed rate to mm/s', () => {
    expect(formatToolheadSpeed(12000)).toBe('200 mm/s');
    expect(formatToolheadSpeed(1500)).toBe('25 mm/s');
  });

  it('shows a placeholder when stopped or unknown', () => {
    expect(formatToolheadSpeed(0)).toBe('-- mm/s');
    expect(formatToolheadSpeed(undefined)).toBe('-- mm/s');
  });
});
