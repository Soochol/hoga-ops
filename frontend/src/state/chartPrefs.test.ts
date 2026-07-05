import { describe, it, expect, beforeEach } from 'vitest';
import { useChartPrefsStore, DEFAULT_PREFS } from './chartPrefs';

describe('useChartPrefsStore', () => {
  beforeEach(() => {
    useChartPrefsStore.getState().resetToDefaults();
  });

  it('initializes with DEFAULT_PREFS', () => {
    const s = useChartPrefsStore.getState();
    for (const key of Object.keys(DEFAULT_PREFS) as Array<keyof typeof DEFAULT_PREFS>) {
      expect(s[key]).toEqual(DEFAULT_PREFS[key]);
    }
  });

  it('setToggle mutates the named boolean', () => {
    useChartPrefsStore.getState().setToggle('auctionWindowMask', false);
    expect(useChartPrefsStore.getState().auctionWindowMask).toBe(false);
  });

  it('setNumericPref mutates the named number', () => {
    useChartPrefsStore.getState().setNumericPref('ratioOutlierThreshold', 42);
    expect(useChartPrefsStore.getState().ratioOutlierThreshold).toBe(42);
  });

  it('resetToDefaults restores DEFAULT_PREFS', () => {
    useChartPrefsStore.getState().setToggle('auctionWindowMask', false);
    useChartPrefsStore.getState().resetToDefaults();
    expect(useChartPrefsStore.getState().auctionWindowMask).toBe(true);
  });
});

import { mergePrefs, CHART_PREFS_KEY } from './chartPrefsPersistence';

describe('chartPrefsPersistence', () => {
  it('mergePrefs ignores invalid types and falls back to DEFAULT_PREFS', () => {
    const merged = mergePrefs({ auctionWindowMask: 'not-a-bool', ratioOutlierThreshold: 999_999 });
    expect(merged.auctionWindowMask).toBe(DEFAULT_PREFS.auctionWindowMask);
    expect(merged.ratioOutlierThreshold).toBe(DEFAULT_PREFS.ratioOutlierThreshold);
  });

  it('mergePrefs accepts valid values', () => {
    const merged = mergePrefs({ auctionWindowMask: false, ratioOutlierThreshold: 50 });
    expect(merged.auctionWindowMask).toBe(false);
    expect(merged.ratioOutlierThreshold).toBe(50);
  });

  it('uses the new key, not replay.tabs.*', () => {
    expect(CHART_PREFS_KEY).toBe('hoga.chart.prefs.v1');
    expect(CHART_PREFS_KEY.includes('replay')).toBe(false);
  });
});

describe('candleTooltipEnabled 토글', () => {
  it('기본값 true', () => {
    expect(DEFAULT_PREFS.candleTooltipEnabled).toBe(true);
  });

  it('persist 된 false 를 보존', () => {
    expect(mergePrefs({ candleTooltipEnabled: false }).candleTooltipEnabled).toBe(false);
  });

  it('없으면 기본값(true) 으로 폴백', () => {
    expect(mergePrefs({}).candleTooltipEnabled).toBe(true);
  });
});

describe('캔들 기준 Y축 토글', () => {
  it('기본값은 false', () => {
    expect(DEFAULT_PREFS.candlePaneCandleOnlyScale).toBe(false);
  });

  it('mergePrefs는 persisted true/false를 보존하고 invalid type은 기본값으로 폴백한다', () => {
    expect(mergePrefs({ candlePaneCandleOnlyScale: true }).candlePaneCandleOnlyScale).toBe(true);
    expect(mergePrefs({ candlePaneCandleOnlyScale: false }).candlePaneCandleOnlyScale).toBe(false);
    expect(mergePrefs({ candlePaneCandleOnlyScale: 'true' as never }).candlePaneCandleOnlyScale)
      .toBe(DEFAULT_PREFS.candlePaneCandleOnlyScale);
  });
});

describe('거래량 체결강도 누적 토글', () => {
  it('기본값은 false', () => {
    expect(DEFAULT_PREFS.volumeFillStrengthCumulative).toBe(false);
  });

  it('mergePrefs는 false를 보존한다', () => {
    expect(mergePrefs({ volumeFillStrengthCumulative: false }).volumeFillStrengthCumulative).toBe(false);
    expect(mergePrefs({ volumeFillStrengthCumulative: true }).volumeFillStrengthCumulative).toBe(true);
    expect(mergePrefs({ volumeFillStrengthCumulative: 'true' as never }).volumeFillStrengthCumulative)
      .toBe(DEFAULT_PREFS.volumeFillStrengthCumulative);
  });
});

import { CHART_TOGGLES, CHART_NUMERIC_PREFS, categoryOf } from './chartPrefs';

describe('총잔량 급증 설정', () => {
  it('surgeMarkerEnabled 토글 기본 ON · category indicator-modal', () => {
    expect(DEFAULT_PREFS.surgeMarkerEnabled).toBe(true);
    const t = CHART_TOGGLES.find((t) => t.key === 'surgeMarkerEnabled');
    expect(t).toBeDefined();
    expect(categoryOf(t!)).toBe('indicator-modal');
  });

  it('surgeApproachPct(기본 95, 80–100)·surgeRearmPct(기본 85, 50–95) enabledBy surgeMarkerEnabled', () => {
    expect(DEFAULT_PREFS.surgeApproachPct).toBe(95);
    expect(DEFAULT_PREFS.surgeRearmPct).toBe(85);
    const ap = CHART_NUMERIC_PREFS.find((p) => p.key === 'surgeApproachPct');
    expect(ap?.enabledBy).toBe('surgeMarkerEnabled');
    expect(ap?.min).toBe(80);
    expect(ap?.max).toBe(100);
    const re = CHART_NUMERIC_PREFS.find((p) => p.key === 'surgeRearmPct');
    expect(re?.enabledBy).toBe('surgeMarkerEnabled');
    expect(re?.min).toBe(50);
    expect(re?.max).toBe(95);
  });

  it('surgeStartHHMM(기본 900, 900–1520) enabledBy surgeMarkerEnabled', () => {
    expect(DEFAULT_PREFS.surgeStartHHMM).toBe(900);
    const st = CHART_NUMERIC_PREFS.find((p) => p.key === 'surgeStartHHMM');
    expect(st?.enabledBy).toBe('surgeMarkerEnabled');
    expect(st?.min).toBe(900);
    expect(st?.max).toBe(1520);
  });

  it('persist 된 surge 값 보존 + 범위 밖은 폴백', () => {
    expect(mergePrefs({ surgeMarkerEnabled: false }).surgeMarkerEnabled).toBe(false);
    expect(mergePrefs({ surgeApproachPct: 90 }).surgeApproachPct).toBe(90);
    expect(mergePrefs({ surgeApproachPct: 999 }).surgeApproachPct).toBe(DEFAULT_PREFS.surgeApproachPct);
    expect(mergePrefs({ surgeRearmPct: 70 }).surgeRearmPct).toBe(70);
    expect(mergePrefs({ surgeStartHHMM: 930 }).surgeStartHHMM).toBe(930);
    expect(mergePrefs({ surgeStartHHMM: 800 }).surgeStartHHMM).toBe(DEFAULT_PREFS.surgeStartHHMM);
  });
});

describe('날짜 구분선 설정', () => {
  it('defaults to current visual behavior', () => {
    expect(DEFAULT_PREFS.dayBoundaryEnabled).toBe(true);
    expect(DEFAULT_PREFS.dayBoundaryColor).toBe('#64748B');
    expect(DEFAULT_PREFS.dayBoundaryLineWidth).toBe(1);
  });

  it('mergePrefs preserves valid day boundary style values', () => {
    const merged = mergePrefs({
      dayBoundaryEnabled: false,
      dayBoundaryColor: '#EF4444',
      dayBoundaryLineWidth: 3,
    });

    expect(merged.dayBoundaryEnabled).toBe(false);
    expect(merged.dayBoundaryColor).toBe('#EF4444');
    expect(merged.dayBoundaryLineWidth).toBe(3);
  });

  it('mergePrefs falls back for invalid day boundary style values', () => {
    const merged = mergePrefs({
      dayBoundaryColor: 'red',
      dayBoundaryLineWidth: 9,
    });

    expect(merged.dayBoundaryColor).toBe(DEFAULT_PREFS.dayBoundaryColor);
    expect(merged.dayBoundaryLineWidth).toBe(DEFAULT_PREFS.dayBoundaryLineWidth);
  });

  it('setDayBoundaryStyle updates color and width independently', () => {
    useChartPrefsStore.getState().setDayBoundaryStyle({ color: '#22C55E' });
    expect(useChartPrefsStore.getState().dayBoundaryColor).toBe('#22C55E');
    expect(useChartPrefsStore.getState().dayBoundaryLineWidth).toBe(1);

    useChartPrefsStore.getState().setDayBoundaryStyle({ lineWidth: 4 });
    expect(useChartPrefsStore.getState().dayBoundaryColor).toBe('#22C55E');
    expect(useChartPrefsStore.getState().dayBoundaryLineWidth).toBe(4);
  });
});

describe('차트 배경 구분선 설정', () => {
  it('defaults horizontal and vertical grid lines on', () => {
    expect(DEFAULT_PREFS.horizontalGridLinesEnabled).toBe(true);
    expect(DEFAULT_PREFS.verticalGridLinesEnabled).toBe(true);
  });

  it('mergePrefs preserves persisted grid line toggles', () => {
    const merged = mergePrefs({
      horizontalGridLinesEnabled: false,
      verticalGridLinesEnabled: false,
    });

    expect(merged.horizontalGridLinesEnabled).toBe(false);
    expect(merged.verticalGridLinesEnabled).toBe(false);
  });

  it('registers grid line toggles in the chart settings category', () => {
    const horizontal = CHART_TOGGLES.find((t) => t.key === 'horizontalGridLinesEnabled');
    const vertical = CHART_TOGGLES.find((t) => t.key === 'verticalGridLinesEnabled');

    expect(horizontal?.label).toBe('가로 구분선');
    expect(vertical?.label).toBe('세로 구분선');
    expect(categoryOf(horizontal!)).toBe('chart');
    expect(categoryOf(vertical!)).toBe('chart');
  });
});

describe('ask peak all-price toggle', () => {
  it('defaults on and belongs to the indicator modal', () => {
    expect(DEFAULT_PREFS.askPeakShowAllPrices).toBe(true);
    const t = CHART_TOGGLES.find((t) => t.key === 'askPeakShowAllPrices');
    expect(t).toBeDefined();
    expect(t?.label).toBe('미체결 최대 매도벽 표시');
    expect(categoryOf(t!)).toBe('indicator-modal');
  });

  it('mergePrefs preserves persisted false', () => {
    expect(mergePrefs({ askPeakShowAllPrices: false }).askPeakShowAllPrices).toBe(false);
  });

  it('label display toggles default on and persist false', () => {
    const ask = CHART_TOGGLES.find((t) => t.key === 'askPeakLabelEnabled');
    const bid = CHART_TOGGLES.find((t) => t.key === 'bidPeakLabelEnabled');

    expect(DEFAULT_PREFS.askPeakLabelEnabled).toBe(true);
    expect(DEFAULT_PREFS.bidPeakLabelEnabled).toBe(true);
    expect(ask?.label).toBe('최대벽 라벨 표시');
    expect(bid?.label).toBe('최대벽 라벨 표시');
    expect(categoryOf(ask!)).toBe('indicator-modal');
    expect(categoryOf(bid!)).toBe('indicator-modal');
    expect(mergePrefs({ askPeakLabelEnabled: false }).askPeakLabelEnabled).toBe(false);
    expect(mergePrefs({ bidPeakLabelEnabled: false }).bidPeakLabelEnabled).toBe(false);
  });

  it('rank limit defaults to 1 and persists valid 1..3 values', () => {
    expect(DEFAULT_PREFS.askPeakAllPriceRankLimit).toBe(1);
    expect(mergePrefs({ askPeakAllPriceRankLimit: 2 }).askPeakAllPriceRankLimit).toBe(2);
    expect(mergePrefs({ askPeakAllPriceRankLimit: 4 }).askPeakAllPriceRankLimit)
      .toBe(DEFAULT_PREFS.askPeakAllPriceRankLimit);
  });

  it('visible max rank limit defaults to 1 and persists valid 1..3 values', () => {
    expect(DEFAULT_PREFS.askPeakVisibleMaxRankLimit).toBe(1);
    expect(mergePrefs({ askPeakVisibleMaxRankLimit: 3 }).askPeakVisibleMaxRankLimit).toBe(3);
    expect(mergePrefs({ askPeakVisibleMaxRankLimit: 0 }).askPeakVisibleMaxRankLimit)
      .toBe(DEFAULT_PREFS.askPeakVisibleMaxRankLimit);
  });

  it('bid rank limits default to 1 and persist valid 1..3 values', () => {
    expect(DEFAULT_PREFS.bidPeakAllPriceRankLimit).toBe(1);
    expect(DEFAULT_PREFS.bidPeakVisibleMaxRankLimit).toBe(1);
    expect(mergePrefs({ bidPeakAllPriceRankLimit: 2 }).bidPeakAllPriceRankLimit).toBe(2);
    expect(mergePrefs({ bidPeakVisibleMaxRankLimit: 3 }).bidPeakVisibleMaxRankLimit).toBe(3);
    expect(mergePrefs({ bidPeakAllPriceRankLimit: 4 }).bidPeakAllPriceRankLimit)
      .toBe(DEFAULT_PREFS.bidPeakAllPriceRankLimit);
    expect(mergePrefs({ bidPeakVisibleMaxRankLimit: 0 }).bidPeakVisibleMaxRankLimit)
      .toBe(DEFAULT_PREFS.bidPeakVisibleMaxRankLimit);
  });

  it('post-touch and untraded rank limits default to 1', () => {
    expect(DEFAULT_PREFS.askPeakAllPriceRankLimit).toBe(1);
    expect(DEFAULT_PREFS.bidPeakAllPriceRankLimit).toBe(1);
    expect(DEFAULT_PREFS.askPeakUntradedRankLimit).toBe(1);
    expect(DEFAULT_PREFS.bidPeakUntradedRankLimit).toBe(1);
  });

  it('persists valid ask/bid untraded rank limits 1..3', () => {
    expect(mergePrefs({ askPeakUntradedRankLimit: 1 }).askPeakUntradedRankLimit).toBe(1);
    expect(mergePrefs({ askPeakUntradedRankLimit: 2 }).askPeakUntradedRankLimit).toBe(2);
    expect(mergePrefs({ askPeakUntradedRankLimit: 3 }).askPeakUntradedRankLimit).toBe(3);
    expect(mergePrefs({ bidPeakUntradedRankLimit: 1 }).bidPeakUntradedRankLimit).toBe(1);
    expect(mergePrefs({ bidPeakUntradedRankLimit: 2 }).bidPeakUntradedRankLimit).toBe(2);
    expect(mergePrefs({ bidPeakUntradedRankLimit: 3 }).bidPeakUntradedRankLimit).toBe(3);
  });

  it('falls back to defaults for invalid untraded rank limit values', () => {
    expect(mergePrefs({ askPeakUntradedRankLimit: 0 }).askPeakUntradedRankLimit)
      .toBe(DEFAULT_PREFS.askPeakUntradedRankLimit);
    expect(mergePrefs({ askPeakUntradedRankLimit: 4 }).askPeakUntradedRankLimit)
      .toBe(DEFAULT_PREFS.askPeakUntradedRankLimit);
    expect(mergePrefs({ askPeakUntradedRankLimit: '2' as never }).askPeakUntradedRankLimit)
      .toBe(DEFAULT_PREFS.askPeakUntradedRankLimit);
    expect(mergePrefs({ bidPeakUntradedRankLimit: 0 }).bidPeakUntradedRankLimit)
      .toBe(DEFAULT_PREFS.bidPeakUntradedRankLimit);
    expect(mergePrefs({ bidPeakUntradedRankLimit: 4 }).bidPeakUntradedRankLimit)
      .toBe(DEFAULT_PREFS.bidPeakUntradedRankLimit);
    expect(mergePrefs({ bidPeakUntradedRankLimit: '2' as never }).bidPeakUntradedRankLimit)
      .toBe(DEFAULT_PREFS.bidPeakUntradedRankLimit);
  });

  it('registers ask/bid untraded rank prefs in the indicator modal with 1..3 bounds', () => {
    const ask = CHART_NUMERIC_PREFS.find((p) => p.key === 'askPeakUntradedRankLimit');
    const bid = CHART_NUMERIC_PREFS.find((p) => p.key === 'bidPeakUntradedRankLimit');

    expect(ask).toMatchObject({
      key: 'askPeakUntradedRankLimit',
      label: '미체결된 벽 표시 개수',
      default: 1,
      min: 1,
      max: 3,
      category: 'indicator-modal',
    });
    expect(bid).toMatchObject({
      key: 'bidPeakUntradedRankLimit',
      label: '미체결된 벽 표시 개수',
      default: 1,
      min: 1,
      max: 3,
      category: 'indicator-modal',
    });
  });

  it('relabels post-touch rank prefs and updates untraded toggle descriptions', () => {
    const askRank = CHART_NUMERIC_PREFS.find((p) => p.key === 'askPeakAllPriceRankLimit');
    const bidRank = CHART_NUMERIC_PREFS.find((p) => p.key === 'bidPeakAllPriceRankLimit');
    const askToggle = CHART_TOGGLES.find((t) => t.key === 'askPeakShowAllPrices');
    const bidToggle = CHART_TOGGLES.find((t) => t.key === 'bidPeakShowAllPrices');

    expect(askRank?.label).toBe('체결된 벽 표시 개수');
    expect(bidRank?.label).toBe('체결된 벽 표시 개수');
    expect(askRank).toMatchObject({ category: 'indicator-modal' });
    expect(bidRank).toMatchObject({ category: 'indicator-modal' });
    expect(askToggle?.description).toContain('미체결된 벽');
    expect(bidToggle?.description).toContain('미체결된 벽');
  });
});

describe('peak wall visible-time cutoff toggles', () => {
  it('defaults both cutoff toggles off in the indicator modal', () => {
    const ask = CHART_TOGGLES.find((t) => t.key === 'askPeakVisibleTimeCutoff');
    const bid = CHART_TOGGLES.find((t) => t.key === 'bidPeakVisibleTimeCutoff');

    expect(DEFAULT_PREFS.askPeakVisibleTimeCutoff).toBe(false);
    expect(DEFAULT_PREFS.bidPeakVisibleTimeCutoff).toBe(false);
    expect(ask?.label).toBe('보이는 최신 봉 기준');
    expect(bid?.label).toBe('보이는 최신 봉 기준');
    expect(categoryOf(ask!)).toBe('indicator-modal');
    expect(categoryOf(bid!)).toBe('indicator-modal');
  });

  it('persists ask and bid cutoff toggles independently', () => {
    const askOnly = mergePrefs({ askPeakVisibleTimeCutoff: true });
    expect(askOnly.askPeakVisibleTimeCutoff).toBe(true);
    expect(askOnly.bidPeakVisibleTimeCutoff).toBe(false);

    const bidOnly = mergePrefs({ bidPeakVisibleTimeCutoff: true });
    expect(bidOnly.askPeakVisibleTimeCutoff).toBe(false);
    expect(bidOnly.bidPeakVisibleTimeCutoff).toBe(true);
  });
});

describe('bid peak toggles', () => {
  it('defaults and belongs to the indicator modal', () => {
    const intra = CHART_TOGGLES.find((t) => t.key === 'bidPeakIntraMax');
    const allPrices = CHART_TOGGLES.find((t) => t.key === 'bidPeakShowAllPrices');

    expect(intra?.default).toBe(false);
    expect(categoryOf(intra!)).toBe('indicator-modal');
    expect(allPrices?.default).toBe(true);
    expect(allPrices?.label).toBe('미체결 최대 매수벽 표시');
    expect(categoryOf(allPrices!)).toBe('indicator-modal');
  });
});
