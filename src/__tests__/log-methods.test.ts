import { describe, expect, it } from 'vitest';
import { METHOD_NAMES } from '../ui/log-methods';

// METHOD_NAMES is the most readable list of methods in the repo, so it is where issues
// copy method numbers from. These pin the rows ELEG-85 corrected, so a later "fix" that
// restores the old labels goes red instead of misleading the next issue.
describe('METHOD_NAMES', () => {
  it('labels 1043 as SetDeviceName, and has no 1060', () => {
    expect(METHOD_NAMES[1043]).toBe('SetDeviceName');
    expect(METHOD_NAMES[1060]).toBeUndefined();
  });

  it('labels capacity once, at 1048', () => {
    expect(METHOD_NAMES[1048]).toBe('GetCapacity');
    const capacity = Object.entries(METHOD_NAMES).filter(([, name]) => name.includes('Capacity'));
    expect(capacity).toEqual([['1048', 'GetCapacity']]);
  });

  it('never gives one operation two numbers', () => {
    const names = Object.values(METHOD_NAMES).map((n) => n.replace(/\?$/, ''));
    const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
    expect(duplicates).toEqual([]);
  });
});
