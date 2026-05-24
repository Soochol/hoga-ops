// frontend/src/chart/drawing/persistence.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import type { Drawing } from './types';
import { loadDrawings, saveDrawings, storageKey } from './persistence';

const CODE = '005930';

beforeEach(() => {
  localStorage.clear();
});

describe('storageKey', () => {
  it('produces the canonical replay.drawings.v1 key', () => {
    expect(storageKey(CODE)).toBe('replay.drawings.v1.005930');
  });
});

describe('saveDrawings / loadDrawings round-trip', () => {
  it('persists and recovers an empty list', () => {
    saveDrawings(CODE, []);
    expect(loadDrawings(CODE)).toEqual([]);
  });

  it('persists and recovers a heterogeneous drawing list', () => {
    const items: Drawing[] = [
      { id: 'a', kind: 'hline', price: 75000, color: '#FFD60A', width: 1.5 },
      {
        id: 'b',
        kind: 'trendline',
        a: { realMs: 1_700_000_000_000, price: 70000 },
        b: { realMs: 1_700_003_600_000, price: 72000 },
        color: '#FFD60A',
        width: 1.5,
      },
    ];
    saveDrawings(CODE, items);
    expect(loadDrawings(CODE)).toEqual(items);
  });
});

describe('loadDrawings — error / version handling', () => {
  it('returns [] when no entry exists', () => {
    expect(loadDrawings(CODE)).toEqual([]);
  });

  it('returns [] for a non-v1 payload', () => {
    localStorage.setItem(storageKey(CODE), JSON.stringify({ v: 2, items: [] }));
    expect(loadDrawings(CODE)).toEqual([]);
  });

  it('returns [] for corrupt JSON', () => {
    localStorage.setItem(storageKey(CODE), '{not valid json');
    expect(loadDrawings(CODE)).toEqual([]);
  });

  it('returns [] when items is not an array', () => {
    localStorage.setItem(storageKey(CODE), JSON.stringify({ v: 1, items: 'nope' }));
    expect(loadDrawings(CODE)).toEqual([]);
  });
});
