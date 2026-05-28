import { describe, it, expect } from 'vitest';
import { mergeLiveIndicatorPrefs, type PersistedIndicators } from './liveIndicatorsPersistence';
import { DEFAULT_LIVE_MAS } from './livePage';

describe('mergeLiveIndicatorPrefs', () => {
  it('returns defaults for undefined input', () => {
    expect(mergeLiveIndicatorPrefs(undefined)).toEqual({
      movingAverages: DEFAULT_LIVE_MAS.map((m) => ({ ...m })),
    });
  });

  it('returns defaults for non-object input', () => {
    expect(mergeLiveIndicatorPrefs('garbage' as unknown as PersistedIndicators).movingAverages)
      .toEqual(DEFAULT_LIVE_MAS.map((m) => ({ ...m })));
  });

  it('returns defaults when movingAverages is not an array', () => {
    expect(
      mergeLiveIndicatorPrefs({ movingAverages: 'oops' as unknown as never } as PersistedIndicators)
        .movingAverages,
    ).toEqual(DEFAULT_LIVE_MAS.map((m) => ({ ...m })));
  });

  it('returns defaults when all entries are invalid', () => {
    expect(
      mergeLiveIndicatorPrefs({ movingAverages: [{}, { id: 1 }] as unknown as never } as PersistedIndicators)
        .movingAverages,
    ).toEqual(DEFAULT_LIVE_MAS.map((m) => ({ ...m })));
  });

  it('keeps a single valid entry when others are invalid', () => {
    const valid = { id: 'k', enabled: true, period: 9, color: '#ffffff', lineWidth: 2, source: 'close' };
    const merged = mergeLiveIndicatorPrefs({
      movingAverages: [valid, { id: 'broken' } as unknown as never],
    } as PersistedIndicators);
    expect(merged.movingAverages).toEqual([valid]);
  });

  it('rejects out-of-range period entries', () => {
    const bad1 = { id: 'a', enabled: true, period: 1, color: '#ffffff', lineWidth: 1, source: 'close' };
    const bad2 = { id: 'b', enabled: true, period: 401, color: '#ffffff', lineWidth: 1, source: 'close' };
    expect(mergeLiveIndicatorPrefs({ movingAverages: [bad1, bad2] }).movingAverages)
      .toEqual(DEFAULT_LIVE_MAS.map((m) => ({ ...m })));
  });

  it('rejects unknown lineWidth values', () => {
    const bad = { id: 'a', enabled: true, period: 10, color: '#ffffff', lineWidth: 5, source: 'close' };
    expect(mergeLiveIndicatorPrefs({ movingAverages: [bad as unknown as never] }).movingAverages)
      .toEqual(DEFAULT_LIVE_MAS.map((m) => ({ ...m })));
  });

  it('rejects unknown source values', () => {
    const bad = { id: 'a', enabled: true, period: 10, color: '#ffffff', lineWidth: 1, source: 'volume' };
    expect(mergeLiveIndicatorPrefs({ movingAverages: [bad as unknown as never] }).movingAverages)
      .toEqual(DEFAULT_LIVE_MAS.map((m) => ({ ...m })));
  });

  it('enforces MA_SLOT_LIMIT — caps to 8 entries, drops the overflow', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      id: `m-${i}`, enabled: true, period: 5 + i, color: '#ffffff', lineWidth: 1 as const, source: 'close' as const,
    }));
    const merged = mergeLiveIndicatorPrefs({ movingAverages: many });
    expect(merged.movingAverages).toHaveLength(8);
    expect(merged.movingAverages.map((m) => m.id)).toEqual(many.slice(0, 8).map((m) => m.id));
  });
});
