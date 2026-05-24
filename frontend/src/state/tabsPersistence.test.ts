import { describe, it, expect, beforeEach } from 'vitest';
import {
  STORAGE_KEY,
  toSnapshot,
  validateSelection,
  mergePrefs,
  loadPersisted,
  savePersisted,
  fromSnapshot,
  type ReplayTabsSnapshot,
  type SnapshotDeps,
} from './tabsPersistence';
import { DEFAULT_PREFS, type Tab, type ChartViewPrefs } from './tabs';

describe('tabsPersistence — module scaffold', () => {
  it('exports STORAGE_KEY = "replay.tabs.v1"', () => {
    expect(STORAGE_KEY).toBe('replay.tabs.v1');
  });
});

describe('toSnapshot', () => {
  it('serializes selection + prefs, excludes bundles/cursorMs/status/id', () => {
    const tab1: Tab = {
      id: 'tab-id-1',
      selection: { code: '005930', fromDate: '20260512', toDate: '20260520', timeframe: '1m' },
      cursorMs: 1_700_000_000_000,
      status: 'loaded',
      bundles: new Map([['20260512', {} as never]]),
    };
    const tab2: Tab = {
      id: 'tab-id-2',
      selection: null,
      cursorMs: null,
      status: 'empty',
      bundles: new Map(),
    };
    const prefs = new Map<string, ChartViewPrefs>([
      ['tab-id-1', { ...DEFAULT_PREFS, volumeProfileMode: 'per-day' }],
    ]);
    const snap = toSnapshot({
      tabs: [tab1, tab2],
      activeTabId: 'tab-id-2',
      prefs,
    });
    expect(snap.version).toBe(1);
    expect(typeof snap.savedAt).toBe('number');
    expect(snap.activeIndex).toBe(1);
    expect(snap.tabs).toHaveLength(2);
    expect(snap.tabs[0].selection).toEqual({
      code: '005930', fromDate: '20260512', toDate: '20260520', timeframe: '1m',
    });
    expect(snap.tabs[0].prefs.volumeProfileMode).toBe('per-day');
    expect(snap.tabs[1].selection).toBeNull();
    // Untouched tabs serialize as empty prefs (forward-compat with default changes).
    expect(snap.tabs[1].prefs).toEqual({});
    // No bundles/cursorMs/status/id leakage.
    expect(JSON.stringify(snap)).not.toContain('cursorMs');
    expect(JSON.stringify(snap)).not.toContain('bundles');
    expect(JSON.stringify(snap)).not.toContain('tab-id-1');
  });

  it('clamps activeIndex to 0 when activeTabId not found', () => {
    const tab: Tab = { id: 'a', selection: null, cursorMs: null, status: 'empty', bundles: new Map() };
    const snap = toSnapshot({
      tabs: [tab],
      activeTabId: 'nonexistent',
      prefs: new Map(),
    });
    expect(snap.activeIndex).toBe(0);
  });

  it('serializes empty prefs for tabs with no entry in the prefs Map', () => {
    const tab: Tab = { id: 'x', selection: null, cursorMs: null, status: 'empty', bundles: new Map() };
    const snap = toSnapshot({ tabs: [tab], activeTabId: 'x', prefs: new Map() });
    expect(snap.tabs[0].prefs).toEqual({});
  });
});

describe('validateSelection', () => {
  it('returns the value when all fields valid', () => {
    const sel = { code: '005930', fromDate: '20260512', toDate: '20260520', timeframe: '1m' };
    expect(validateSelection(sel)).toEqual(sel);
  });
  it('returns null for null input', () => {
    expect(validateSelection(null)).toBeNull();
  });
  it('returns null when code is not 6 digits', () => {
    expect(validateSelection({ code: '5930', fromDate: '20260512', toDate: '20260512', timeframe: '1m' })).toBeNull();
  });
  it('returns null when date is not 8 digits', () => {
    expect(validateSelection({ code: '005930', fromDate: '2026-05-12', toDate: '20260512', timeframe: '1m' })).toBeNull();
  });
  it('returns null when timeframe is not in TIMEFRAME_LABELS', () => {
    expect(validateSelection({ code: '005930', fromDate: '20260512', toDate: '20260512', timeframe: '99m' })).toBeNull();
  });
  it('returns null for non-object input', () => {
    expect(validateSelection('whatever' as unknown)).toBeNull();
    expect(validateSelection(undefined as unknown)).toBeNull();
  });
});

describe('mergePrefs', () => {
  it('returns defaults when given an empty object', () => {
    expect(mergePrefs({}, DEFAULT_PREFS, ['auctionWindowMask'])).toEqual(DEFAULT_PREFS);
  });
  it('overrides known scalar keys', () => {
    const merged = mergePrefs(
      { volumeProfileMode: 'per-day', auctionWindowMask: false },
      DEFAULT_PREFS,
      ['auctionWindowMask'],
    );
    expect(merged.volumeProfileMode).toBe('per-day');
    expect(merged.auctionWindowMask).toBe(false);
  });
  it('ignores unknown volumeProfileMode value', () => {
    const merged = mergePrefs({ volumeProfileMode: 'galaxy' as never }, DEFAULT_PREFS, ['auctionWindowMask']);
    expect(merged.volumeProfileMode).toBe('range');
  });
  it('ignores non-boolean auctionWindowMask', () => {
    const merged = mergePrefs({ auctionWindowMask: 'yes' as never }, DEFAULT_PREFS, ['auctionWindowMask']);
    expect(merged.auctionWindowMask).toBe(true);
  });
  it('replaces movingAverages wholesale when length differs from default', () => {
    const merged = mergePrefs(
      { movingAverages: [{ period: 7, enabled: true }] as never },
      DEFAULT_PREFS,
      ['auctionWindowMask'],
    );
    expect(merged.movingAverages).toEqual(DEFAULT_PREFS.movingAverages);
  });
  it('replaces movingAverages wholesale when an element is malformed', () => {
    const broken = DEFAULT_PREFS.movingAverages.map((m, i) =>
      i === 0 ? ({ period: 'x', enabled: true } as never) : m,
    );
    const merged = mergePrefs({ movingAverages: broken }, DEFAULT_PREFS, ['auctionWindowMask']);
    expect(merged.movingAverages).toEqual(DEFAULT_PREFS.movingAverages);
  });
  it('accepts a fully-shaped movingAverages array', () => {
    const custom = DEFAULT_PREFS.movingAverages.map((m) => ({ ...m, enabled: false }));
    const merged = mergePrefs({ movingAverages: custom }, DEFAULT_PREFS, ['auctionWindowMask']);
    expect(merged.movingAverages).toEqual(custom);
  });
  it('drops unknown keys silently', () => {
    const merged = mergePrefs({ futureKey: 42 } as never, DEFAULT_PREFS, ['auctionWindowMask']);
    expect((merged as Record<string, unknown>).futureKey).toBeUndefined();
  });
  it('merges arbitrary boolean toggles via injected registry', () => {
    // Simulate a future toggle by casting; the test proves the loop, not the type.
    const merged = mergePrefs(
      { auctionWindowMask: false, futureToggle: true } as never,
      DEFAULT_PREFS,
      ['auctionWindowMask', 'futureToggle' as never],
    );
    expect(merged.auctionWindowMask).toBe(false);
    expect((merged as Record<string, unknown>).futureToggle).toBe(true);
  });
});

describe('loadPersisted', () => {
  beforeEach(() => localStorage.clear());

  it('returns null when the key is absent', () => {
    expect(loadPersisted()).toBeNull();
  });

  it('returns null when JSON is corrupt', () => {
    localStorage.setItem('replay.tabs.v1', '{not json');
    expect(loadPersisted()).toBeNull();
  });

  it('returns null when version is missing or wrong', () => {
    localStorage.setItem('replay.tabs.v1', JSON.stringify({ version: 2, tabs: [], activeIndex: 0 }));
    expect(loadPersisted()).toBeNull();
    localStorage.setItem('replay.tabs.v1', JSON.stringify({ tabs: [], activeIndex: 0 }));
    expect(loadPersisted()).toBeNull();
  });

  it('returns null when tabs is not an array', () => {
    localStorage.setItem('replay.tabs.v1', JSON.stringify({ version: 1, tabs: 'nope', activeIndex: 0 }));
    expect(loadPersisted()).toBeNull();
  });

  it('returns the snapshot on a valid payload, preserving tabs verbatim', () => {
    const payload: ReplayTabsSnapshot = {
      version: 1,
      savedAt: 1_700_000_000_000,
      activeIndex: 0,
      tabs: [
        {
          selection: { code: '005930', fromDate: '20260512', toDate: '20260520', timeframe: '5m' },
          prefs: { volumeProfileMode: 'per-day' },
        },
      ],
    };
    localStorage.setItem('replay.tabs.v1', JSON.stringify(payload));
    const out = loadPersisted();
    expect(out).not.toBeNull();
    expect(out!.tabs).toHaveLength(1);
    expect(out!.tabs[0].selection?.code).toBe('005930');
    expect(out!.tabs[0].prefs.volumeProfileMode).toBe('per-day');
  });

  it('coerces invalid selection to null (preserves tab + its prefs)', () => {
    const payload = {
      version: 1, savedAt: 0, activeIndex: 0,
      tabs: [
        {
          selection: { code: 'BAD', fromDate: '20260512', toDate: '20260512', timeframe: '1m' },
          prefs: { volumeProfileMode: 'per-day' },
        },
      ],
    };
    localStorage.setItem('replay.tabs.v1', JSON.stringify(payload));
    const out = loadPersisted();
    expect(out!.tabs[0].selection).toBeNull();
    expect(out!.tabs[0].prefs.volumeProfileMode).toBe('per-day');
  });

  it('returns null when localStorage is unavailable', () => {
    const orig = globalThis.localStorage;
    // simulating SSR/private mode
    delete (globalThis as Record<string, unknown>).localStorage;
    try {
      expect(loadPersisted()).toBeNull();
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: orig, configurable: true });
    }
  });

  it('clamps activeIndex into [0, tabs.length-1]', () => {
    const payload = {
      version: 1, savedAt: 0, activeIndex: 99,
      tabs: [{ selection: null, prefs: {} }, { selection: null, prefs: {} }],
    };
    localStorage.setItem('replay.tabs.v1', JSON.stringify(payload));
    const out = loadPersisted();
    expect(out!.activeIndex).toBe(0);
  });

  it('accepts an empty tabs array (caller seeds fallback)', () => {
    const payload = { version: 1, savedAt: 0, activeIndex: 0, tabs: [] };
    localStorage.setItem('replay.tabs.v1', JSON.stringify(payload));
    const out = loadPersisted();
    expect(out!.tabs).toHaveLength(0);
    expect(out!.activeIndex).toBe(0);
  });
});

describe('savePersisted', () => {
  beforeEach(() => localStorage.clear());

  it('writes a JSON payload under STORAGE_KEY', () => {
    const snap: ReplayTabsSnapshot = {
      version: 1, savedAt: 123, activeIndex: 0,
      tabs: [{ selection: null, prefs: { volumeProfileMode: 'per-day' } }],
    };
    savePersisted(snap);
    const raw = localStorage.getItem('replay.tabs.v1');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!).tabs[0].prefs.volumeProfileMode).toBe('per-day');
  });

  it('silently no-ops when localStorage.setItem throws (quota / private mode)', () => {
    const orig = localStorage.setItem.bind(localStorage);
    localStorage.setItem = () => { throw new DOMException('quota', 'QuotaExceededError'); };
    try {
      expect(() =>
        savePersisted({ version: 1, savedAt: 0, activeIndex: 0, tabs: [] }),
      ).not.toThrow();
    } finally {
      localStorage.setItem = orig;
    }
  });

  it('silently no-ops when localStorage is undefined', () => {
    const orig = globalThis.localStorage;
    // simulating SSR
    delete (globalThis as Record<string, unknown>).localStorage;
    try {
      expect(() =>
        savePersisted({ version: 1, savedAt: 0, activeIndex: 0, tabs: [] }),
      ).not.toThrow();
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: orig, configurable: true });
    }
  });
});

function makeDeps(seq: () => number): SnapshotDeps {
  let n = seq();
  return {
    defaultPrefs: DEFAULT_PREFS,
    freshTab: () => ({
      id: `fresh-${++n}`,
      selection: null,
      cursorMs: null,
      status: 'empty',
      bundles: new Map(),
    }),
    chartToggleKeys: ['auctionWindowMask'],
  };
}

describe('fromSnapshot', () => {
  it('builds tabs + prefs Map + activeTabId, assigning new ids', () => {
    const deps = makeDeps(() => 0);
    const snap: ReplayTabsSnapshot = {
      version: 1, savedAt: 0, activeIndex: 1,
      tabs: [
        { selection: { code: '005930', fromDate: '20260512', toDate: '20260512', timeframe: '1m' }, prefs: { volumeProfileMode: 'per-day' } },
        { selection: null, prefs: {} },
      ],
    };
    const out = fromSnapshot(snap, deps);
    expect(out.tabs).toHaveLength(2);
    // New ids assigned (caller cannot rely on persisted id).
    expect(out.tabs[0].id).not.toBe('');
    expect(out.tabs[1].id).not.toBe('');
    expect(out.tabs[0].id).not.toBe(out.tabs[1].id);
    // Per-tab prefs threaded into the Map under each new id.
    expect(out.prefs.get(out.tabs[0].id)!.volumeProfileMode).toBe('per-day');
    expect(out.prefs.get(out.tabs[1].id)!.volumeProfileMode).toBe('range');
    // status is empty, bundles fresh, cursorMs null (not persisted).
    expect(out.tabs[0].status).toBe('empty');
    expect(out.tabs[0].cursorMs).toBeNull();
    expect(out.tabs[0].bundles.size).toBe(0);
    // activeTabId points at the snapshot's activeIndex.
    expect(out.activeTabId).toBe(out.tabs[1].id);
  });

  it('seeds a single fresh tab when snapshot.tabs is empty', () => {
    const deps = makeDeps(() => 99);
    const out = fromSnapshot(
      { version: 1, savedAt: 0, activeIndex: 0, tabs: [] },
      deps,
    );
    expect(out.tabs).toHaveLength(1);
    expect(out.tabs[0].selection).toBeNull();
    expect(out.prefs.size).toBe(0);
    expect(out.activeTabId).toBe(out.tabs[0].id);
  });

  it('hydrates prefs for a tab whose persisted selection was nulled', () => {
    const deps = makeDeps(() => 0);
    const snap: ReplayTabsSnapshot = {
      version: 1, savedAt: 0, activeIndex: 0,
      tabs: [{ selection: null, prefs: { volumeProfileMode: 'per-day' } }],
    };
    const out = fromSnapshot(snap, deps);
    expect(out.tabs[0].selection).toBeNull();
    expect(out.prefs.get(out.tabs[0].id)!.volumeProfileMode).toBe('per-day');
  });
});
