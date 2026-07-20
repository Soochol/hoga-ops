// frontend/src/chart/drawing/persistence.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import type { Drawing } from './types';
import {
  loadDrawings, saveDrawings, storageKey, legacyStorageKey, drawingScope,
  loadDefaults, saveDefaults, DEFAULTS_KEY,
} from './persistence';
import { PANE_SPECS } from '../paneSpecs';
import { INITIAL_DEFAULTS } from './types';

const CODE = '005930';
const SCOPE = drawingScope(CODE, 'minute');

beforeEach(() => {
  localStorage.clear();
});

describe('storageKey / drawingScope', () => {
  it('produces the canonical replay.drawings.v2 key, scoped by slot', () => {
    expect(storageKey(SCOPE)).toBe('replay.drawings.v2.005930|minute');
    expect(storageKey(drawingScope(CODE, 'D'))).toBe('replay.drawings.v2.005930|D');
  });

  it('keeps the pre-slot v1 key addressable by bare code', () => {
    expect(legacyStorageKey(CODE)).toBe('replay.drawings.v1.005930');
  });
});

describe('saveDrawings / loadDrawings round-trip', () => {
  it('persists and recovers an empty list', () => {
    saveDrawings(SCOPE, []);
    expect(loadDrawings(SCOPE)).toEqual([]);
  });

  it('persists and recovers a heterogeneous drawing list', () => {
    const items: Drawing[] = [
      { id: 'a', kind: 'hline', price: 75000, color: '#FFD60A', width: 1.5, paneId: 'candle', lineStyle: 'solid' },
      {
        id: 'b',
        kind: 'trendline',
        a: { realMs: 1_700_000_000_000, price: 70000 },
        b: { realMs: 1_700_003_600_000, price: 72000 },
        color: '#FFD60A',
        width: 1.5,
        paneId: 'candle',
        lineStyle: 'solid',
      },
    ];
    saveDrawings(SCOPE, items);
    expect(loadDrawings(SCOPE)).toEqual(items);
  });
});

describe('loadDrawings — error / version handling', () => {
  it('returns [] when no entry exists', () => {
    expect(loadDrawings(SCOPE)).toEqual([]);
  });

  it('returns [] for a non-v1 payload', () => {
    localStorage.setItem(storageKey(SCOPE), JSON.stringify({ v: 2, items: [] }));
    expect(loadDrawings(SCOPE)).toEqual([]);
  });

  it('returns [] for corrupt JSON', () => {
    localStorage.setItem(storageKey(SCOPE), '{not valid json');
    expect(loadDrawings(SCOPE)).toEqual([]);
  });

  it('returns [] when items is not an array', () => {
    localStorage.setItem(storageKey(SCOPE), JSON.stringify({ v: 1, items: 'nope' }));
    expect(loadDrawings(SCOPE)).toEqual([]);
  });
});

describe('loadDrawings — timeframe slot isolation', () => {
  const mk = (id: string, price: number): Drawing =>
    ({ id, kind: 'hline', price, color: '#FFD60A', width: 1.5, paneId: 'candle', lineStyle: 'solid' });

  it('keeps each slot of the same code independent', () => {
    saveDrawings(drawingScope(CODE, 'minute'), [mk('m', 1)]);
    saveDrawings(drawingScope(CODE, 'D'), [mk('d', 2)]);
    expect(loadDrawings(drawingScope(CODE, 'minute'))).toEqual([mk('m', 1)]);
    expect(loadDrawings(drawingScope(CODE, 'D'))).toEqual([mk('d', 2)]);
    expect(loadDrawings(drawingScope(CODE, 'W'))).toEqual([]);
  });
});

describe('loadDrawings — pre-slot (v1) migration', () => {
  const mk = (id: string, price: number): Drawing =>
    ({ id, kind: 'hline', price, color: '#FFD60A', width: 1.5, paneId: 'candle', lineStyle: 'solid' });

  const seedLegacy = (items: Drawing[]) =>
    localStorage.setItem(legacyStorageKey(CODE), JSON.stringify({ v: 1, items }));

  it('seeds EVERY slot from the pre-slot payload — nothing disappears on upgrade', () => {
    seedLegacy([mk('old', 1)]);
    for (const slot of ['minute', 'D', 'W', 'M'] as const) {
      expect(loadDrawings(drawingScope(CODE, slot))).toEqual([mk('old', 1)]);
    }
  });

  it('a slot forks off the seed on its first write, leaving other slots on it', () => {
    seedLegacy([mk('old', 1)]);
    saveDrawings(drawingScope(CODE, 'minute'), [mk('old', 1), mk('new', 2)]);
    expect(loadDrawings(drawingScope(CODE, 'minute'))).toEqual([mk('old', 1), mk('new', 2)]);
    // 아직 안 건드린 슬롯은 여전히 v1 시드를 본다.
    expect(loadDrawings(drawingScope(CODE, 'D'))).toEqual([mk('old', 1)]);
  });

  it('an emptied slot stays empty instead of resurrecting the v1 snapshot', () => {
    // 회귀 가드: 시드 판정이 "키 존재" 가 아니라 "목록 비어있지 않음" 이면,
    // 사용자가 "모두 지우기" 로 비운 슬롯이 다음 로드에서 되살아난다.
    seedLegacy([mk('old', 1)]);
    saveDrawings(drawingScope(CODE, 'D'), []);
    expect(loadDrawings(drawingScope(CODE, 'D'))).toEqual([]);
  });

  it('does not consume another code\'s pre-slot payload', () => {
    seedLegacy([mk('old', 1)]);
    expect(loadDrawings(drawingScope('000660', 'minute'))).toEqual([]);
  });

  it('normalizes legacy items while seeding (paneId / lineStyle backfill)', () => {
    localStorage.setItem(
      legacyStorageKey(CODE),
      JSON.stringify({ v: 1, items: [{ id: 'a', kind: 'hline', price: 10, color: '#14B8A6', width: 1.5 }] }),
    );
    const loaded = loadDrawings(drawingScope(CODE, 'W'));
    expect(loaded[0]).toMatchObject({ id: 'a', paneId: 'candle', lineStyle: 'solid' });
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
    localStorage.setItem(storageKey(SCOPE), JSON.stringify(legacy));
    const loaded = loadDrawings(SCOPE);
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
    localStorage.setItem(storageKey(SCOPE), JSON.stringify(legacy));
    const loaded = loadDrawings(SCOPE);
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
    localStorage.setItem(storageKey(SCOPE), JSON.stringify(legacy));
    expect(loadDrawings(SCOPE)[0].paneId).toBe('candle');
  });
});

describe('loadDrawings — lineStyle hydration', () => {
  it('defaults lineStyle to "solid" for legacy items missing the field', () => {
    const legacy = {
      v: 1,
      items: [
        { id: 'a', kind: 'hline', price: 1000, color: '#14B8A6', width: 1.5, paneId: 'candle' },
      ],
    };
    localStorage.setItem(storageKey(SCOPE), JSON.stringify(legacy));
    const loaded = loadDrawings(SCOPE);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].lineStyle).toBe('solid');
    expect(loaded[0].width).toBe(1.5); // preserved as-is
  });
});

describe('drawing defaults persistence', () => {
  beforeEach(() => localStorage.clear());

  it('returns INITIAL_DEFAULTS when no key present', () => {
    expect(loadDefaults()).toEqual(INITIAL_DEFAULTS);
  });

  it('round-trips a written value', () => {
    const written = { color: '#F43F5E', width: 4, lineStyle: 'dashed' as const, fontSize: 13, magnet: false, hiddenAll: false };
    saveDefaults(written);
    expect(loadDefaults()).toEqual(written);
  });

  it('returns INITIAL_DEFAULTS on JSON corruption', () => {
    localStorage.setItem(DEFAULTS_KEY, '{not valid json');
    expect(loadDefaults()).toEqual(INITIAL_DEFAULTS);
  });

  it('returns INITIAL_DEFAULTS when wrapper version mismatches', () => {
    localStorage.setItem(DEFAULTS_KEY, JSON.stringify({ v: 99, value: { color: '#000' } }));
    expect(loadDefaults()).toEqual(INITIAL_DEFAULTS);
  });
});
