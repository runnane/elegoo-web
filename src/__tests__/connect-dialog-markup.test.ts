import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The connect dialog once carried two inputs pre-filled with a developer's
// printer address and the vendor password. Nothing read them (the printer is
// configured server-side), so they only misled users. Guard the committed markup.
const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');

describe('index.html connect dialog', () => {
  it('has no dead printer address / password inputs', () => {
    expect(html).not.toMatch(/id=["']printer-ip["']/);
    expect(html).not.toMatch(/id=["']printer-password["']/);
  });

  it('pre-fills no input with an IPv4 address', () => {
    const inputs = html.match(/<input\b[^>]*>/gi) ?? [];
    const ipv4 = /\bvalue=["']\s*\d{1,3}(?:\.\d{1,3}){3}\s*["']/i;
    const offenders = inputs.filter((tag) => ipv4.test(tag));
    expect(offenders).toEqual([]);
  });

  it('keeps the elements connectToService depends on', () => {
    expect(html).toMatch(/id=["']connect-btn["']/);
    expect(html).toMatch(/id=["']connect-error["']/);
  });
});
