import { describe, expect, it } from 'vitest';
import { gcodeCacheKey } from '../rest-api.js';

/**
 * ELEG-105: the gcode cache is shared process-wide (`gcodeCacheDir()`), and after
 * ELEG-95 the service can switch between connection presets at runtime. Two printers
 * routinely hold a same-named gcode file (a slicer's default export name, e.g.
 * `benchy.gcode`) with different contents, so the cache key must depend on the active
 * printer's identity as well as the file name — otherwise a switch can serve printer
 * B a preview cached from printer A.
 *
 * Addresses use TEST-NET-1 (RFC 5737, `192.0.2.0/24`) rather than any real printer.
 */
describe('gcodeCacheKey', () => {
  it('gives two different cache paths for the same file name under two different printer keys', () => {
    const a = gcodeCacheKey('192.0.2.10', 'benchy.gcode');
    const b = gcodeCacheKey('192.0.2.11', 'benchy.gcode');
    expect(a).not.toBe(b);
  });

  it('gives the same cache path for the same file name under the same printer key (accepting control)', () => {
    const a = gcodeCacheKey('192.0.2.10', 'benchy.gcode');
    const b = gcodeCacheKey('192.0.2.10', 'benchy.gcode');
    expect(a).toBe(b);
  });
});
