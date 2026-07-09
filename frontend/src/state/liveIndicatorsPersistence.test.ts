import { describe, it, expect } from 'vitest';
import { mergeLiveIndicatorPrefs, DEFAULT_DAILY_MAS, type PersistedIndicators } from './liveIndicatorsPersistence';
import { DEFAULT_LIVE_MAS } from './livePage';

describe('mergeLiveIndicatorPrefs', () => {
  it('returns defaults for undefined input', () => {
    expect(mergeLiveIndicatorPrefs(undefined)).toEqual({
      movingAverages: DEFAULT_LIVE_MAS.map((m) => ({ ...m })),
      movingAverageEnabled: true,
      foreignNetEnabled: false,
      institutionNetEnabled: false,
      volumeEnabled: true,
      movingAverageHidden: false,
      askPeakEnabled: false,
      askPeakColor: '#1D4ED8',
      askPeakLineWidth: 2,
      askPeakAllPriceColor: '#F97316',
      askPeakAllPriceLineWidth: 1,
      askPeakVisibleMaxColor: '#EAB308',
      askPeakVisibleMaxLineWidth: 3,
      viLimitPriceLineColor: '#EAB308',
      viLimitPriceLineWidth: 3,
      bidPeakEnabled: false,
      bidPeakColor: '#DC2626',
      bidPeakLineWidth: 2,
      bidPeakAllPriceColor: '#F97316',
      bidPeakAllPriceLineWidth: 1,
      tradeVolumePocEnabled: true,
      tradeVolumePocBandPct: 0.005,
      tradeVolumePocColor: '#A855F7',
      tradeVolumePocOpacity: 0.12,
      depthHeatmapEnabled: false,
      depthHeatmapBidColor: '#F04452',
      depthHeatmapAskColor: '#3485FA',
      depthHeatmapMaxOpacity: 0.7,
      volumeDistributionEnabled: true,
      volumeDistributionHoverCutoffEnabled: false,
      volumeDistributionRangeCount: 10,
      volumeDistributionColor: '#64748B',
      volumeDistributionMaxColor: '#EAB308',
      quoteTotalsEnabled: true,
      quoteTotalsLevelLineEnabled: false,
      quoteTotalsBidLevelColor: '#F04452',
      quoteTotalsBidLevelWidth: 1,
      quoteTotalsBidLevelStyle: 'dashed',
      quoteTotalsAskLevelColor: '#3485FA',
      quoteTotalsAskLevelWidth: 1,
      quoteTotalsAskLevelStyle: 'dashed',
      ratioEnabled: true,
      ratioLevelLineEnabled: false,
      ratioLevelColor: '#9A9AA8',
      ratioLevelWidth: 1,
      ratioLevelStyle: 'dashed',
      fillStrengthEnabled: true,
      programTradeEnabled: true,
      brokerLateEntryEnabled: false,
      brokerLateEntryStartHHMM: 930,
      brokerLateEntrySideMode: 'both',
      brokerLateEntryBuyColor: '#ef4444',
      brokerLateEntrySellColor: '#3b82f6',
      panePrefsByTimeframe: {},
      dailyMovingAverages: DEFAULT_DAILY_MAS.map((m) => ({ ...m })),
      dailyMovingAverageEnabled: false,
      dailyMovingAverageHidden: false,
    });
  });

  it('persisted movingAverageEnabled=false survives merge', () => {
    const merged = mergeLiveIndicatorPrefs({
      movingAverages: DEFAULT_LIVE_MAS.map((m) => ({ ...m })),
      movingAverageEnabled: false,
    });
    expect(merged.movingAverageEnabled).toBe(false);
  });

  it('missing movingAverageEnabled defaults to true (legacy stores)', () => {
    const merged = mergeLiveIndicatorPrefs({
      movingAverages: DEFAULT_LIVE_MAS.map((m) => ({ ...m })),
    } as unknown as PersistedIndicators);
    expect(merged.movingAverageEnabled).toBe(true);
  });

  it('returns defaults for non-object input', () => {
    expect(mergeLiveIndicatorPrefs('garbage' as unknown as PersistedIndicators).movingAverages)
      .toEqual(DEFAULT_LIVE_MAS.map((m) => ({ ...m })));
  });

  it('returns defaults when movingAverages is not an array', () => {
    expect(
      mergeLiveIndicatorPrefs({ movingAverages: 'oops' } as unknown as PersistedIndicators)
        .movingAverages,
    ).toEqual(DEFAULT_LIVE_MAS.map((m) => ({ ...m })));
  });

  it('returns defaults when all entries are invalid', () => {
    expect(
      mergeLiveIndicatorPrefs({ movingAverages: [{}, { id: 1 }] } as unknown as PersistedIndicators)
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

  it('investor toggles default to false (opt-in) on legacy stores', () => {
    const merged = mergeLiveIndicatorPrefs({
      movingAverages: DEFAULT_LIVE_MAS.map((m) => ({ ...m })),
    } as unknown as PersistedIndicators);
    expect(merged.foreignNetEnabled).toBe(false);
    expect(merged.institutionNetEnabled).toBe(false);
  });

  it('persisted investor toggles survive the merge', () => {
    const merged = mergeLiveIndicatorPrefs({
      movingAverages: DEFAULT_LIVE_MAS.map((m) => ({ ...m })),
      foreignNetEnabled: true,
      institutionNetEnabled: true,
    } as unknown as PersistedIndicators);
    expect(merged.foreignNetEnabled).toBe(true);
    expect(merged.institutionNetEnabled).toBe(true);
  });

  it('volumeEnabled defaults true (kept for legacy stores)', () => {
    const m = mergeLiveIndicatorPrefs({
      movingAverages: DEFAULT_LIVE_MAS.map((x) => ({ ...x })),
    } as unknown as PersistedIndicators);
    expect(m.volumeEnabled).toBe(true);
  });

  it('persisted volumeEnabled=false survives', () => {
    const m = mergeLiveIndicatorPrefs({
      movingAverages: DEFAULT_LIVE_MAS.map((x) => ({ ...x })),
      volumeEnabled: false,
    } as unknown as PersistedIndicators);
    expect(m.volumeEnabled).toBe(false);
  });

  it('movingAverageHidden defaults false (opt-in hide)', () => {
    const m = mergeLiveIndicatorPrefs({
      movingAverages: DEFAULT_LIVE_MAS.map((x) => ({ ...x })),
    } as unknown as PersistedIndicators);
    expect(m.movingAverageHidden).toBe(false);
  });

  it('normalizes broker late-entry defaults and invalid persisted values', () => {
    expect(mergeLiveIndicatorPrefs(undefined)).toMatchObject({
      brokerLateEntryEnabled: false,
      brokerLateEntryStartHHMM: 930,
      brokerLateEntrySideMode: 'both',
      brokerLateEntryBuyColor: '#ef4444',
      brokerLateEntrySellColor: '#3b82f6',
    });

    expect(mergeLiveIndicatorPrefs({
      movingAverages: DEFAULT_LIVE_MAS.map((m) => ({ ...m })),
      brokerLateEntryEnabled: true,
      brokerLateEntryStartHHMM: 800,
      brokerLateEntrySideMode: 'ask',
      brokerLateEntryBuyColor: 'hot',
      brokerLateEntrySellColor: '#12345g',
    } as unknown as PersistedIndicators)).toMatchObject({
      brokerLateEntryEnabled: true,
      brokerLateEntryStartHHMM: 930,
      brokerLateEntrySideMode: 'both',
      brokerLateEntryBuyColor: '#ef4444',
      brokerLateEntrySellColor: '#3b82f6',
    });
  });
});

describe('mergeLiveIndicatorPrefs — 호가 토글', () => {
  it('panePrefsByTimeframe defaults to an empty override map', () => {
    expect(mergeLiveIndicatorPrefs(undefined).panePrefsByTimeframe).toEqual({});
  });

  it('preserves valid partial pane timeframe profiles', () => {
    const m = mergeLiveIndicatorPrefs({
      panePrefsByTimeframe: {
        minute: { ratioEnabled: false },
        D: { volumeEnabled: false, foreignNetEnabled: true },
      },
    });
    expect(m.panePrefsByTimeframe).toEqual({
      minute: { ratioEnabled: false },
      D: { volumeEnabled: false, foreignNetEnabled: true },
    });
  });

  it('drops invalid pane profile payload pieces', () => {
    const m = mergeLiveIndicatorPrefs({
      panePrefsByTimeframe: {
        minute: { ratioEnabled: 'false', fillStrengthEnabled: true },
        Q: { volumeEnabled: false },
        W: ['bad'],
      },
    } as never);
    expect(m.panePrefsByTimeframe).toEqual({
      minute: { fillStrengthEnabled: true },
    });
  });

  it('빈 입력 → 호가 4토글 기본 ON', () => {
    const m = mergeLiveIndicatorPrefs(undefined);
    expect(m.quoteTotalsEnabled).toBe(true);
    expect(m.ratioEnabled).toBe(true);
    expect(m.fillStrengthEnabled).toBe(true);
    expect(m.programTradeEnabled).toBe(true);
    expect(m.tradeVolumePocEnabled).toBe(true);
    expect(m.tradeVolumePocBandPct).toBe(0.005);
    expect(m.tradeVolumePocColor).toBe('#A855F7');
    expect(m.tradeVolumePocOpacity).toBe(0.12);
  });
  it('구버전 store(키 없음) → ON으로 머지', () => {
    const m = mergeLiveIndicatorPrefs({ movingAverages: [], movingAverageEnabled: true });
    expect(m.quoteTotalsEnabled).toBe(true);
    expect(m.ratioEnabled).toBe(true);
    expect(m.fillStrengthEnabled).toBe(true);
    expect(m.programTradeEnabled).toBe(true);
    expect(m.tradeVolumePocEnabled).toBe(true);
    expect(m.tradeVolumePocBandPct).toBe(0.005);
    expect(m.tradeVolumePocColor).toBe('#A855F7');
    expect(m.tradeVolumePocOpacity).toBe(0.12);
  });
  it('명시적 false 보존', () => {
    const m = mergeLiveIndicatorPrefs({
      ratioEnabled: false,
      fillStrengthEnabled: false,
      programTradeEnabled: false,
      tradeVolumePocEnabled: false,
    });
    expect(m.ratioEnabled).toBe(false);
    expect(m.fillStrengthEnabled).toBe(false);
    expect(m.programTradeEnabled).toBe(false);
    expect(m.tradeVolumePocEnabled).toBe(false);
    expect(m.quoteTotalsEnabled).toBe(true);
  });
  it('최대 매물대 band pct는 0.25%, 0.5%, 1%만 보존', () => {
    expect(mergeLiveIndicatorPrefs({ tradeVolumePocBandPct: 0.0025 }).tradeVolumePocBandPct).toBe(0.0025);
    expect(mergeLiveIndicatorPrefs({ tradeVolumePocBandPct: 0.01 }).tradeVolumePocBandPct).toBe(0.01);
    expect(mergeLiveIndicatorPrefs({ tradeVolumePocBandPct: 0.123 }).tradeVolumePocBandPct).toBe(0.005);
  });
  it('최대 매물대 색상/투명도 유효값만 보존', () => {
    const valid = mergeLiveIndicatorPrefs({
      tradeVolumePocColor: '#22C55E',
      tradeVolumePocOpacity: 0.24,
    });
    expect(valid.tradeVolumePocColor).toBe('#22C55E');
    expect(valid.tradeVolumePocOpacity).toBe(0.24);

    const invalid = mergeLiveIndicatorPrefs({
      tradeVolumePocColor: 'purple',
      tradeVolumePocOpacity: 1.2,
    });
    expect(invalid.tradeVolumePocColor).toBe('#A855F7');
    expect(invalid.tradeVolumePocOpacity).toBe(0.12);
  });
  it('depthHeatmap 기본값을 채운다', () => {
    const merged = mergeLiveIndicatorPrefs({});
    expect(merged.depthHeatmapEnabled).toBe(false);
    expect(merged.depthHeatmapBidColor).toBe('#F04452');
    expect(merged.depthHeatmapAskColor).toBe('#3485FA');
    expect(merged.depthHeatmapMaxOpacity).toBeCloseTo(0.7, 5);
  });
  it('depthHeatmap 잘못된 색/불투명도는 기본값으로 폴백', () => {
    const merged = mergeLiveIndicatorPrefs({
      depthHeatmapBidColor: 'not-a-hex', depthHeatmapMaxOpacity: 5,
    } as never);
    expect(merged.depthHeatmapBidColor).toBe('#F04452');
    expect(merged.depthHeatmapMaxOpacity).toBeCloseTo(0.7, 5);
  });
  it('depthHeatmap 유효한 값은 보존한다', () => {
    const merged = mergeLiveIndicatorPrefs({
      depthHeatmapEnabled: true, depthHeatmapAskColor: '#123abc', depthHeatmapMaxOpacity: 0.5,
    } as never);
    expect(merged.depthHeatmapEnabled).toBe(true);
    expect(merged.depthHeatmapAskColor).toBe('#123abc');
    expect(merged.depthHeatmapMaxOpacity).toBeCloseTo(0.5, 5);
  });
  it('연속체결 매물대 분포 기본값/범위/색상 정규화', () => {
    const defaults = mergeLiveIndicatorPrefs(undefined);
    expect(defaults.volumeDistributionEnabled).toBe(true);
    expect(defaults.volumeDistributionRangeCount).toBe(10);
    expect(defaults.volumeDistributionColor).toBe('#64748B');
    expect(defaults.volumeDistributionMaxColor).toBe('#EAB308');

    const valid = mergeLiveIndicatorPrefs({
      volumeDistributionEnabled: false,
      volumeDistributionRangeCount: 24,
      volumeDistributionColor: '#22C55E',
      volumeDistributionMaxColor: '#EF4444',
    });
    expect(valid.volumeDistributionEnabled).toBe(false);
    expect(valid.volumeDistributionRangeCount).toBe(24);
    expect(valid.volumeDistributionColor).toBe('#22C55E');
    expect(valid.volumeDistributionMaxColor).toBe('#EF4444');

    const invalid = mergeLiveIndicatorPrefs({
      volumeDistributionRangeCount: 100,
      volumeDistributionColor: 'slate',
      volumeDistributionMaxColor: '#fff',
    });
    expect(invalid.volumeDistributionRangeCount).toBe(30);
    expect(invalid.volumeDistributionColor).toBe('#64748B');
    expect(invalid.volumeDistributionMaxColor).toBe('#EAB308');
    expect(mergeLiveIndicatorPrefs({ volumeDistributionRangeCount: 1 }).volumeDistributionRangeCount).toBe(5);
    expect(mergeLiveIndicatorPrefs({ volumeDistributionRangeCount: '12.8' as never }).volumeDistributionRangeCount).toBe(10);
  });

  it('defaults hover cutoff volume distribution mode to false and preserves persisted values', () => {
    const defaults = mergeLiveIndicatorPrefs({});
    expect(defaults.volumeDistributionHoverCutoffEnabled).toBe(false);

    expect(mergeLiveIndicatorPrefs({ volumeDistributionHoverCutoffEnabled: true }).volumeDistributionHoverCutoffEnabled).toBe(true);
    expect(mergeLiveIndicatorPrefs({ volumeDistributionHoverCutoffEnabled: false }).volumeDistributionHoverCutoffEnabled).toBe(false);
  });
});

describe('mergeLiveIndicatorPrefs — askPeak', () => {
  it('레거시(필드 없음): 기본 off/#1D4ED8/2 + all-price #F97316/1', () => {
    const m = mergeLiveIndicatorPrefs(undefined);
    expect(m.askPeakEnabled).toBe(false);
    expect(m.askPeakColor).toBe('#1D4ED8');
    expect(m.askPeakLineWidth).toBe(2);
    expect(m.askPeakAllPriceColor).toBe('#F97316');
    expect(m.askPeakAllPriceLineWidth).toBe(1);
  });
  it('bid peak prefs default to opt-in false with KRX buy colors', () => {
    const merged = mergeLiveIndicatorPrefs(undefined);
    expect(merged.bidPeakEnabled).toBe(false);
    expect(merged.bidPeakColor).toBe('#DC2626');
    expect(merged.bidPeakLineWidth).toBe(2);
    expect(merged.bidPeakAllPriceColor).toBe('#F97316');
    expect(merged.bidPeakAllPriceLineWidth).toBe(1);
  });
  it('유효값 보존', () => {
    const m = mergeLiveIndicatorPrefs({
      askPeakEnabled: true,
      askPeakColor: '#EF4444',
      askPeakLineWidth: 3,
      askPeakAllPriceColor: '#22C55E',
      askPeakAllPriceLineWidth: 4,
    });
    expect(m.askPeakEnabled).toBe(true);
    expect(m.askPeakColor).toBe('#EF4444');
    expect(m.askPeakLineWidth).toBe(3);
    expect(m.askPeakAllPriceColor).toBe('#22C55E');
    expect(m.askPeakAllPriceLineWidth).toBe(4);
  });
  it('레거시(필드 없음): visible max 기본 #EAB308/3', () => {
    const m = mergeLiveIndicatorPrefs(undefined);
    expect(m.askPeakVisibleMaxColor).toBe('#EAB308');
    expect(m.askPeakVisibleMaxLineWidth).toBe(3);
  });
  it('visible max 유효값 보존', () => {
    const m = mergeLiveIndicatorPrefs({
      askPeakVisibleMaxColor: '#A855F7',
      askPeakVisibleMaxLineWidth: 4,
    });
    expect(m.askPeakVisibleMaxColor).toBe('#A855F7');
    expect(m.askPeakVisibleMaxLineWidth).toBe(4);
  });
  it('visible max 이상값 폴백', () => {
    const m = mergeLiveIndicatorPrefs({
      askPeakVisibleMaxColor: 'yellow',
      askPeakVisibleMaxLineWidth: 9,
    });
    expect(m.askPeakVisibleMaxColor).toBe('#EAB308');
    expect(m.askPeakVisibleMaxLineWidth).toBe(3);
  });
  it('VI/상하한가 선 스타일 기본값은 보이는 영역 최대벽과 같은 #EAB308/3', () => {
    const m = mergeLiveIndicatorPrefs(undefined);
    expect(m.viLimitPriceLineColor).toBe('#EAB308');
    expect(m.viLimitPriceLineWidth).toBe(3);
  });
  it('VI/상하한가 선 스타일 유효값 보존', () => {
    const m = mergeLiveIndicatorPrefs({
      viLimitPriceLineColor: '#A855F7',
      viLimitPriceLineWidth: 4,
    });
    expect(m.viLimitPriceLineColor).toBe('#A855F7');
    expect(m.viLimitPriceLineWidth).toBe(4);
  });
  it('VI/상하한가 선 스타일 이상값 폴백', () => {
    const m = mergeLiveIndicatorPrefs({
      viLimitPriceLineColor: 'gold',
      viLimitPriceLineWidth: 9,
    });
    expect(m.viLimitPriceLineColor).toBe('#EAB308');
    expect(m.viLimitPriceLineWidth).toBe(3);
  });
  it('이상값 폴백', () => {
    const m = mergeLiveIndicatorPrefs({
      askPeakColor: 'red',
      askPeakLineWidth: 9,
      askPeakAllPriceColor: 'orange',
      askPeakAllPriceLineWidth: 0,
    });
    expect(m.askPeakColor).toBe('#1D4ED8');
    expect(m.askPeakLineWidth).toBe(2);
    expect(m.askPeakAllPriceColor).toBe('#F97316');
    expect(m.askPeakAllPriceLineWidth).toBe(1);
  });
});

describe('mergeLiveIndicatorPrefs — daily MA', () => {
  it('빈 입력 → 1 슬롯(period 20) + enabled false(opt-in)', () => {
    const m = mergeLiveIndicatorPrefs(undefined);
    expect(m.dailyMovingAverages).toEqual(DEFAULT_DAILY_MAS.map((x) => ({ ...x })));
    expect(m.dailyMovingAverageEnabled).toBe(false);
    expect(m.dailyMovingAverageHidden).toBe(false);
  });
  it('enabled는 === true만 ON', () => {
    expect(mergeLiveIndicatorPrefs({ dailyMovingAverageEnabled: true }).dailyMovingAverageEnabled).toBe(true);
    expect(mergeLiveIndicatorPrefs({ dailyMovingAverageEnabled: 'yes' as unknown as boolean }).dailyMovingAverageEnabled).toBe(false);
  });
  it('손상 daily 슬롯 필터, 전부 무효면 기본값', () => {
    const valid = { id: 'dma-1', enabled: true, period: 60, color: '#ffffff', lineWidth: 2, source: 'close' };
    expect(mergeLiveIndicatorPrefs({ dailyMovingAverages: [valid, { id: 'x' }] } as never).dailyMovingAverages).toEqual([valid]);
    expect(mergeLiveIndicatorPrefs({ dailyMovingAverages: [{}, { id: 1 }] } as never).dailyMovingAverages)
      .toEqual(DEFAULT_DAILY_MAS.map((x) => ({ ...x })));
  });
});
