import { describe, expect, it } from 'vitest';
import { ALL_CARD_IDS } from '../ui/card-layout';
import {
  MOBILE_DASHBOARD_SECTIONS,
  MOBILE_SECTION_CARDS,
  mobilePlacementForCard,
  normaliseMobileSection,
  normaliseMoreSubTab,
} from '../ui/mobile-nav';

describe('mobile-nav', () => {
  it('assigns every known dashboard card to exactly one mobile section', () => {
    const seen = new Map<string, string>();
    for (const section of MOBILE_DASHBOARD_SECTIONS) {
      for (const cardId of MOBILE_SECTION_CARDS[section]) {
        expect(seen.has(cardId), `duplicate card ${cardId}`).toBe(false);
        seen.set(cardId, section);
      }
    }
    for (const cardId of ALL_CARD_IDS) {
      expect(seen.has(cardId), `missing card ${cardId}`).toBe(true);
    }
    expect(seen.get('print-status-bar')).toBe('overview');
  });

  it('places print status first and camera second in overview', () => {
    const status = mobilePlacementForCard('print-status-bar');
    const camera = mobilePlacementForCard('camera-card');
    expect(status.section).toBe('overview');
    expect(camera.section).toBe('overview');
    expect(status.order).toBe(1);
    expect(camera.order).toBe(2);
  });

  it('falls back unknown cards to monitor at the end', () => {
    expect(mobilePlacementForCard('future-card')).toEqual({ section: 'monitor', order: 99 });
  });

  it('normalises mobile section and more sub-tab values safely', () => {
    expect(normaliseMobileSection('files')).toBe('files');
    expect(normaliseMobileSection('more')).toBe('more');
    expect(normaliseMobileSection('bogus')).toBe('overview');
    expect(normaliseMobileSection(null)).toBe('overview');

    expect(normaliseMoreSubTab('tools')).toBe('tools');
    expect(normaliseMoreSubTab('debug')).toBe('debug');
    expect(normaliseMoreSubTab('invalid')).toBe('settings');
    expect(normaliseMoreSubTab(undefined)).toBe('settings');
  });
});
