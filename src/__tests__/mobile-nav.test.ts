import { describe, expect, it } from 'vitest';
import { ALL_CARD_IDS } from '../ui/card-layout';
import {
  MOBILE_DASHBOARD_SECTIONS,
  MOBILE_SECTION_CARDS,
  mobileSectionForCard,
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

  it('puts print status and the camera in overview', () => {
    expect(mobileSectionForCard('print-status-bar')).toBe('overview');
    expect(mobileSectionForCard('camera-card')).toBe('overview');
  });

  it('falls back unknown cards to monitor', () => {
    expect(mobileSectionForCard('future-card')).toBe('monitor');
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
