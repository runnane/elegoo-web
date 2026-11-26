// @vitest-environment jsdom
/**
 * ELEG-170 — the spool calculator must flag impossible input inline, show "—" in the
 * tiles instead of a result, and never persist the impossible values.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { renderSpoolCalc } from '../ui/spool-calc';

const KEY = 'elegoo-web-spool-calc';

function el(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}

function type(id: string, value: string): void {
  const input = el(id);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '<div id="tools-content"></div>';
  renderSpoolCalc();
});

describe('spool calculator input validation', () => {
  it('shows a valid result and persists it', () => {
    type('sc-current-weight', '750');
    expect(el('sc-percent').textContent).toBe('50%');
    expect(el('sc-hub-dia').getAttribute('aria-invalid')).toBeNull();
    expect(JSON.parse(localStorage.getItem(KEY) ?? '{}').currentWeight).toBe(750);
  });

  it('flags a hub above the flange, blanks the tiles and does not persist it', () => {
    type('sc-current-weight', '750');
    type('sc-hub-dia', '250');
    expect(el('sc-hub-dia').getAttribute('aria-invalid')).toBe('true');
    const msg = document.getElementById('sc-err-hubDiameter');
    expect(msg?.hidden).toBe(false);
    expect(msg?.textContent).toMatch(/smaller than the flange/);
    expect(el('sc-percent').textContent).toBe('—');
    expect(el('sc-meters').textContent).toBe('—');
    expect(JSON.parse(localStorage.getItem(KEY) ?? '{}').hubDiameter).toBe(55);
  });

  it('clears the flag again once the input is fixed', () => {
    type('sc-hub-dia', '250');
    type('sc-hub-dia', '55');
    expect(el('sc-hub-dia').getAttribute('aria-invalid')).toBeNull();
    expect(document.getElementById('sc-err-hubDiameter')?.hidden).toBe(true);
    expect(el('sc-percent').textContent).toBe('100%');
  });

  it('rejects an outer diameter above the flange without rewriting the weight', () => {
    const before = el('sc-current-weight').value;
    type('sc-outer-dia', '300');
    expect(el('sc-outer-dia').getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById('sc-err-currentOuterDiameter')?.textContent).toMatch(
      /exceed the flange/,
    );
    expect(el('sc-current-weight').value).toBe(before);
    expect(el('sc-percent').textContent).toBe('—');
  });
});
