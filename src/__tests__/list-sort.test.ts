import { describe, it, expect } from 'vitest';
import {
  type SortColumn,
  compareValues,
  directionIndicator,
  filterItems,
  matchesQuery,
  nextSortState,
  nonZero,
  normaliseSortState,
  sortItems,
  spanSeconds,
} from '../ui/list-sort';

interface Row {
  name: string;
  size?: number;
  folder?: boolean;
}

const byName: SortColumn<Row> = { key: 'name', label: 'Name', value: (r) => r.name };
const bySize: SortColumn<Row> = {
  key: 'size',
  label: 'Size',
  value: (r) => r.size,
  initialDirection: 'desc',
};

describe('compareValues', () => {
  it('orders numbers numerically, not lexically', () => {
    expect(compareValues(9, 10)).toBeLessThan(0);
    expect(compareValues(10, 9)).toBeGreaterThan(0);
    expect(compareValues(5, 5)).toBe(0);
  });

  it('orders strings case-insensitively via localeCompare', () => {
    expect(compareValues('apple', 'Banana')).toBeLessThan(0);
    expect(compareValues('b', 'a')).toBeGreaterThan(0);
  });

  it('puts missing values last, and treats an empty string as missing', () => {
    expect(compareValues(undefined, 3)).toBeGreaterThan(0);
    expect(compareValues(3, undefined)).toBeLessThan(0);
    expect(compareValues(undefined, undefined)).toBe(0);
    expect(compareValues('', 'a')).toBeGreaterThan(0);
  });
});

describe('sortItems', () => {
  it('sorts ascending and descending by the named column', () => {
    const rows: Row[] = [{ name: 'b' }, { name: 'c' }, { name: 'a' }];
    expect(sortItems(rows, byName, 'asc').map((r) => r.name)).toEqual(['a', 'b', 'c']);
    expect(sortItems(rows, byName, 'desc').map((r) => r.name)).toEqual(['c', 'b', 'a']);
  });

  it('does not mutate the input', () => {
    const rows: Row[] = [{ name: 'b' }, { name: 'a' }];
    sortItems(rows, byName, 'asc');
    expect(rows.map((r) => r.name)).toEqual(['b', 'a']);
  });

  it('keeps ties in arrival order, so a re-render does not reshuffle equal rows', () => {
    const rows: Row[] = [
      { name: 'first', size: 5 },
      { name: 'second', size: 5 },
      { name: 'third', size: 5 },
    ];
    expect(sortItems(rows, bySize, 'asc').map((r) => r.name)).toEqual(['first', 'second', 'third']);
    // Reversing direction must not reverse the tiebreak either.
    expect(sortItems(rows, bySize, 'desc').map((r) => r.name)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('keeps missing values last in BOTH directions', () => {
    const rows: Row[] = [{ name: 'a', size: 1 }, { name: 'b' }, { name: 'c', size: 3 }];
    expect(sortItems(rows, bySize, 'asc').map((r) => r.name)).toEqual(['a', 'c', 'b']);
    expect(sortItems(rows, bySize, 'desc').map((r) => r.name)).toEqual(['c', 'a', 'b']);
  });

  it('holds the group ahead of the sort column, in both directions', () => {
    const rows: Row[] = [
      { name: 'zebra.gcode', size: 9 },
      { name: 'alpha', folder: true },
      { name: 'beta.gcode', size: 1 },
      { name: 'omega', folder: true },
    ];
    const group = (r: Row) => (r.folder ? 0 : 1);

    const asc = sortItems(rows, byName, 'asc', { group });
    expect(asc.map((r) => r.name)).toEqual(['alpha', 'omega', 'beta.gcode', 'zebra.gcode']);

    // Descending flips the names but folders are still the first two — the grouping is
    // not a sort key and must survive a direction change.
    const desc = sortItems(rows, byName, 'desc', { group });
    expect(desc.map((r) => r.name)).toEqual(['omega', 'alpha', 'zebra.gcode', 'beta.gcode']);
    expect(desc.slice(0, 2).every((r) => r.folder)).toBe(true);

    // And it survives a change of column, too.
    const bySizeDesc = sortItems(rows, bySize, 'desc', { group });
    expect(bySizeDesc.slice(0, 2).every((r) => r.folder)).toBe(true);
  });

  it('returns a plain copy when there is no column and no group', () => {
    const rows: Row[] = [{ name: 'b' }, { name: 'a' }];
    expect(sortItems(rows, undefined, 'asc').map((r) => r.name)).toEqual(['b', 'a']);
  });
});

describe('matchesQuery', () => {
  it('matches case-insensitively on a substring', () => {
    expect(matchesQuery('BENCH', 'benchy_v2.gcode')).toBe(true);
    expect(matchesQuery('chy_v', 'benchy_v2.gcode')).toBe(true);
    expect(matchesQuery('cube', 'benchy_v2.gcode')).toBe(false);
  });

  it('treats an empty or whitespace-only query as no filter', () => {
    expect(matchesQuery('', 'anything')).toBe(true);
    expect(matchesQuery('   ', 'anything')).toBe(true);
  });
});

describe('filterItems', () => {
  const rows: Row[] = [{ name: 'benchy.gcode' }, { name: 'cube.gcode' }, { name: 'Bench_plate' }];

  it('keeps only matching rows', () => {
    expect(filterItems(rows, 'bench', (r) => r.name).map((r) => r.name)).toEqual([
      'benchy.gcode',
      'Bench_plate',
    ]);
  });

  it('returns a copy of everything for an empty query', () => {
    const out = filterItems(rows, '  ', (r) => r.name);
    expect(out).toHaveLength(3);
    expect(out).not.toBe(rows);
  });

  it('keeps a row when any of several fields matches', () => {
    const out = filterItems(rows, 'plate', (r) => [r.name, r.folder ? 'folder' : 'file']);
    expect(out.map((r) => r.name)).toEqual(['Bench_plate']);
  });
});

describe('nextSortState', () => {
  it('toggles direction when the same column is clicked again', () => {
    expect(nextSortState({ key: 'name', dir: 'asc' }, byName)).toEqual({
      key: 'name',
      dir: 'desc',
    });
    expect(nextSortState({ key: 'name', dir: 'desc' }, byName)).toEqual({
      key: 'name',
      dir: 'asc',
    });
  });

  it('adopts the new column initial direction when switching columns', () => {
    expect(nextSortState({ key: 'name', dir: 'desc' }, bySize)).toEqual({
      key: 'size',
      dir: 'desc',
    });
    expect(nextSortState({ key: 'size', dir: 'desc' }, byName)).toEqual({
      key: 'name',
      dir: 'asc',
    });
  });
});

describe('normaliseSortState', () => {
  const fallback = { key: 'name', dir: 'asc' } as const;
  const keys = ['name', 'size'];

  it('accepts a stored state whose column still exists', () => {
    expect(normaliseSortState({ key: 'size', dir: 'desc' }, keys, fallback)).toEqual({
      key: 'size',
      dir: 'desc',
    });
  });

  it('falls back when the stored column has been removed or renamed', () => {
    expect(normaliseSortState({ key: 'gone', dir: 'desc' }, keys, fallback)).toEqual(fallback);
  });

  it('survives junk in storage', () => {
    expect(normaliseSortState(null, keys, fallback)).toEqual(fallback);
    expect(normaliseSortState('nonsense', keys, fallback)).toEqual(fallback);
    expect(normaliseSortState({}, keys, fallback)).toEqual(fallback);
  });

  it('defaults an unrecognised direction to ascending', () => {
    expect(normaliseSortState({ key: 'size', dir: 'sideways' }, keys, fallback)).toEqual({
      key: 'size',
      dir: 'asc',
    });
  });

  it('returns a fresh object so the caller cannot mutate the default', () => {
    const out = normaliseSortState(null, keys, fallback);
    expect(out).not.toBe(fallback);
  });
});

describe('nonZero', () => {
  it('treats the printer zero as absent, not as 1970', () => {
    expect(nonZero(0)).toBeUndefined();
    expect(nonZero(undefined)).toBeUndefined();
    expect(nonZero(Number.NaN)).toBeUndefined();
  });

  it('passes real values through, including negatives', () => {
    expect(nonZero(1700000000)).toBe(1700000000);
    expect(nonZero(-5)).toBe(-5);
  });

  it('keeps unrecorded rows at the bottom whichever way the column is sorted', () => {
    interface Job {
      name: string;
      begin: number;
    }
    const jobs: Job[] = [
      { name: 'unrecorded', begin: 0 },
      { name: 'older', begin: 1000 },
      { name: 'newer', begin: 2000 },
    ];
    const column: SortColumn<Job> = {
      key: 'started',
      label: 'Started',
      value: (j) => nonZero(j.begin),
    };
    expect(sortItems(jobs, column, 'desc').map((j) => j.name)).toEqual([
      'newer',
      'older',
      'unrecorded',
    ]);
    // Ascending is the case that actually needs `nonZero`: a raw 0 is the smallest
    // number, so without the mapping the unrecorded row leads the oldest-first list.
    expect(sortItems(jobs, column, 'asc').map((j) => j.name)).toEqual([
      'older',
      'newer',
      'unrecorded',
    ]);
  });
});

describe('spanSeconds', () => {
  it('measures a finished job', () => {
    expect(spanSeconds(1000, 1600)).toBe(600);
  });

  it('has no answer for a job that has not finished or never started', () => {
    expect(spanSeconds(1000, 0)).toBeUndefined();
    expect(spanSeconds(0, 1600)).toBeUndefined();
    expect(spanSeconds(undefined, undefined)).toBeUndefined();
  });

  it('rejects a nonsensical span rather than returning a negative duration', () => {
    expect(spanSeconds(1600, 1000)).toBeUndefined();
    expect(spanSeconds(1000, 1000)).toBeUndefined();
  });
});

describe('directionIndicator', () => {
  it('distinguishes the two directions', () => {
    expect(directionIndicator('asc')).not.toBe(directionIndicator('desc'));
  });
});
