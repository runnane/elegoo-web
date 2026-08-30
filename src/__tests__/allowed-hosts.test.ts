import { describe, expect, it } from 'vitest';
import { allowedHostsFrom } from '../../vite.config';

// ELEG-82. `server.allowedHosts` used to hardcode a deployment hostname and a
// private LAN address in this public repo; they now come from
// VITE_ALLOWED_HOSTS. Only the parsing is testable here — whether the dev
// server actually answers on a host needs `pnpm dev:web`, because `vite build`
// never reads `server.*`.
describe('allowedHostsFrom', () => {
  it('defaults to localhost alone when the variable is unset', () => {
    expect(allowedHostsFrom(undefined)).toEqual(['localhost']);
  });

  it('defaults to localhost alone when the variable is empty', () => {
    expect(allowedHostsFrom('')).toEqual(['localhost']);
  });

  it('appends each comma-separated host to localhost', () => {
    expect(allowedHostsFrom('a.example.test,b.example.test')).toEqual([
      'localhost',
      'a.example.test',
      'b.example.test',
    ]);
  });

  it('trims whitespace and drops empty entries', () => {
    expect(allowedHostsFrom(' a.example.test , , b.example.test ,')).toEqual([
      'localhost',
      'a.example.test',
      'b.example.test',
    ]);
  });

  it('does not repeat localhost when it is also listed explicitly', () => {
    expect(allowedHostsFrom('localhost,a.example.test')).toEqual(['localhost', 'a.example.test']);
  });
});
