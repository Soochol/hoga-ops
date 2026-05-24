// frontend/src/chart/drawing/persistence.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import type { Drawing } from './types';
import { loadDrawings, saveDrawings, storageKey } from './persistence';
import { PANE_SPECS } from '../paneSpecs';

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
      { id: 'a', kind: 'hline', price: 75000, color: '#FFD60A', width: 1.5, paneId: 'candle' },
      {
        id: 'b',
        kind: 'trendline',
        a: { realMs: 1_700_000_000_000, price: 70000 },
        b: { realMs: 1_700_003_600_000, price: 72000 },
        color: '#FFD60A',
        width: 1.5,
        paneId: 'candle',
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

describe('loadDrawings — paneId migration', () => {
  it("backfills paneId='candle' on items missing paneId", () => {
    const legacy = {
      v: 1,
      items: [
        // No paneId field — pre-Task-1 payload.
        { id: 'a', kind: 'hline', price: 75000, color: '#14B8A6', width: 1.5 },
      ],
    };
    localStorage.setItem(storageKey(CODE), JSON.stringify(legacy));
    const loaded = loadDrawings(CODE);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ id: 'a', kind: 'hline', paneId: 'candle' });
  });

  it('resolves legacy paneIndex via PANE_SPECS to a paneId', () => {
    const ratioIdx = PANE_SPECS.findIndex((s) => s.name === 'ratio');
    expect(ratioIdx).toBeGreaterThanOrEqual(0);
    const legacy = {
      v: 1,
      items: [
        {
          id: 'b',
          kind: 'hline',
          price: 0.42,
          color: '#14B8A6',
          width: 1.5,
          paneIndex: ratioIdx,
        },
      ],
    };
    localStorage.setItem(storageKey(CODE), JSON.stringify(legacy));
    const loaded = loadDrawings(CODE);
    expect(loaded[0].paneId).toBe('ratio');
    expect((loaded[0] as Drawing & { paneIndex?: number }).paneIndex).toBeUndefined();
  });

  it("falls back to paneId='candle' when paneIndex is out of range", () => {
    const legacy = {
      v: 1,
      items: [
        { id: 'c', kind: 'hline', price: 1, color: '#14B8A6', width: 1.5, paneIndex: 999 },
      ],
    };
    localStorage.setItem(storageKey(CODE), JSON.stringify(legacy));
    expect(loadDrawings(CODE)[0].paneId).toBe('candle');
  });
});
