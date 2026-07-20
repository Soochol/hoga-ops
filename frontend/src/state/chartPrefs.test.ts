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

import {
  mergePrefs,
  mergeIndicatorModalByTimeframe,
  CHART_PREFS_KEY,
} from './chartPrefsPersistence';
import { resolveIndicatorModalPrefs } from './chartPrefs';

/** 구 flat 블롭이 hydrate 를 거친 뒤 분봉 뷰에서 보이는 유효값(PR-B) —
 *  indicator-modal 키는 minute 버킷 시드 ⊕ 기본값 투영으로 읽힌다. */
const hydratedMinuteView = (raw: object): typeof DEFAULT_PREFS => ({
  ...mergePrefs(raw),
  ...resolveIndicatorModalPrefs(mergeIndicatorModalByTimeframe(raw), '1m'),
} as typeof DEFAULT_PREFS);

describe('chartPrefsPersistence', () => {
  it('mergePrefs ignores invalid types and falls back to DEFAULT_PREFS', () => {
    const merged = hydratedMinuteView({ auctionWindowMask: 'not-a-bool', ratioOutlierThreshold: 999_999 });
    expect(merged.auctionWindowMask).toBe(DEFAULT_PREFS.auctionWindowMask);
    expect(merged.ratioOutlierThreshold).toBe(DEFAULT_PREFS.ratioOutlierThreshold);
  });

  it('mergePrefs accepts valid chart-wide values; IM 키는 minute 시드로 읽힌다', () => {
    const merged = mergePrefs({ auctionWindowMask: false, ratioOutlierThreshold: 50 });
    expect(merged.auctionWindowMask).toBe(false);
    // indicator-modal 키는 flat 에서 더 이상 읽지 않는다(PR-B) — 시드 경로로만.
    expect(merged.ratioOutlierThreshold).toBe(DEFAULT_PREFS.ratioOutlierThreshold);
    expect(hydratedMinuteView({ ratioOutlierThreshold: 50 }).ratioOutlierThreshold).toBe(50);
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

describe('체결창 대량 체결 강조 (trade-window 카테고리)', () => {
  it('기본값 — 토글 ON · 5,000만원 · 노랑 (#EAB308)', () => {
    expect(DEFAULT_PREFS.tradeHighlightEnabled).toBe(true);
    expect(DEFAULT_PREFS.tradeHighlightThresholdManwon).toBe(5000);
    expect(DEFAULT_PREFS.tradeHighlightColor).toBe('#EAB308');
  });

  it('trade-window 는 indicator-modal 이 아니다 — flat(전역) 저장·병합 경로를 탄다', () => {
    // per-timeframe 버킷 대상으로 오분류되면 flat 에서 안 읽혀 설정이 증발한다.
    const merged = mergePrefs({ tradeHighlightEnabled: false, tradeHighlightThresholdManwon: 10_000 });
    expect(merged.tradeHighlightEnabled).toBe(false);
    expect(merged.tradeHighlightThresholdManwon).toBe(10_000);
  });

  it('mergePrefs 색상 — 유효 hex 는 대문자 정규화, 무효는 기본값 폴백', () => {
    expect(mergePrefs({ tradeHighlightColor: '#ef4444' }).tradeHighlightColor).toBe('#EF4444');
    expect(mergePrefs({ tradeHighlightColor: 'red' }).tradeHighlightColor)
      .toBe(DEFAULT_PREFS.tradeHighlightColor);
    expect(mergePrefs({ tradeHighlightColor: '#EAB30859' }).tradeHighlightColor)
      .toBe(DEFAULT_PREFS.tradeHighlightColor); // 8자리(알파 포함)는 거부 — 알파는 렌더 시 얹는다
  });

  it('mergePrefs 임계값 — 범위 밖·비정수는 기본값 폴백', () => {
    expect(mergePrefs({ tradeHighlightThresholdManwon: 50 }).tradeHighlightThresholdManwon)
      .toBe(DEFAULT_PREFS.tradeHighlightThresholdManwon); // min 100 미만
    expect(mergePrefs({ tradeHighlightThresholdManwon: 2_000_000 }).tradeHighlightThresholdManwon)
      .toBe(DEFAULT_PREFS.tradeHighlightThresholdManwon); // max 초과
    expect(mergePrefs({ tradeHighlightThresholdManwon: 500.5 }).tradeHighlightThresholdManwon)
      .toBe(DEFAULT_PREFS.tradeHighlightThresholdManwon); // 정수 아님
  });
});

describe('거래량 체결강도 누적 토글', () => {
  it('기본값은 false', () => {
    expect(DEFAULT_PREFS.volumeFillStrengthCumulative).toBe(false);
  });

  it('mergePrefs는 false를 보존한다', () => {
    expect(hydratedMinuteView({ volumeFillStrengthCumulative: false }).volumeFillStrengthCumulative).toBe(false);
    expect(hydratedMinuteView({ volumeFillStrengthCumulative: true }).volumeFillStrengthCumulative).toBe(true);
    expect(hydratedMinuteView({ volumeFillStrengthCumulative: 'true' as never }).volumeFillStrengthCumulative)
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
    expect(hydratedMinuteView({ surgeMarkerEnabled: false }).surgeMarkerEnabled).toBe(false);
    expect(hydratedMinuteView({ surgeApproachPct: 90 }).surgeApproachPct).toBe(90);
    expect(hydratedMinuteView({ surgeApproachPct: 999 }).surgeApproachPct).toBe(DEFAULT_PREFS.surgeApproachPct);
    expect(hydratedMinuteView({ surgeRearmPct: 70 }).surgeRearmPct).toBe(70);
    expect(hydratedMinuteView({ surgeStartHHMM: 930 }).surgeStartHHMM).toBe(930);
    expect(hydratedMinuteView({ surgeStartHHMM: 800 }).surgeStartHHMM).toBe(DEFAULT_PREFS.surgeStartHHMM);
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
    expect(hydratedMinuteView({ askPeakShowAllPrices: false }).askPeakShowAllPrices).toBe(false);
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
    expect(hydratedMinuteView({ askPeakLabelEnabled: false }).askPeakLabelEnabled).toBe(false);
    expect(hydratedMinuteView({ bidPeakLabelEnabled: false }).bidPeakLabelEnabled).toBe(false);
  });

  it('rank limit defaults to 1 and persists valid 1..3 values', () => {
    expect(DEFAULT_PREFS.askPeakAllPriceRankLimit).toBe(1);
    expect(hydratedMinuteView({ askPeakAllPriceRankLimit: 2 }).askPeakAllPriceRankLimit).toBe(2);
    expect(hydratedMinuteView({ askPeakAllPriceRankLimit: 4 }).askPeakAllPriceRankLimit)
      .toBe(DEFAULT_PREFS.askPeakAllPriceRankLimit);
  });

  it('visible max rank limit defaults to 1 and persists valid 0..3 values', () => {
    expect(DEFAULT_PREFS.askPeakVisibleMaxRankLimit).toBe(1);
    expect(CHART_NUMERIC_PREFS.find((p) => p.key === 'askPeakVisibleMaxRankLimit')?.label)
      .toBe('보이는 영역 최대벽 표시 개수');
    expect(hydratedMinuteView({ askPeakVisibleMaxRankLimit: 0 }).askPeakVisibleMaxRankLimit).toBe(0);
    expect(hydratedMinuteView({ askPeakVisibleMaxRankLimit: 3 }).askPeakVisibleMaxRankLimit).toBe(3);
    expect(hydratedMinuteView({ askPeakVisibleMaxRankLimit: 4 }).askPeakVisibleMaxRankLimit)
      .toBe(DEFAULT_PREFS.askPeakVisibleMaxRankLimit);
  });

  it('bid rank limits default to 1 and persist valid 1..3 values', () => {
    expect(DEFAULT_PREFS.bidPeakAllPriceRankLimit).toBe(1);
    expect(DEFAULT_PREFS.bidPeakVisibleMaxRankLimit).toBe(1);
    expect(CHART_NUMERIC_PREFS.find((p) => p.key === 'bidPeakVisibleMaxRankLimit')?.label)
      .toBe('보이는 영역 최대벽 표시 개수');
    expect(hydratedMinuteView({ bidPeakAllPriceRankLimit: 2 }).bidPeakAllPriceRankLimit).toBe(2);
    expect(hydratedMinuteView({ bidPeakVisibleMaxRankLimit: 0 }).bidPeakVisibleMaxRankLimit).toBe(0);
    expect(hydratedMinuteView({ bidPeakVisibleMaxRankLimit: 3 }).bidPeakVisibleMaxRankLimit).toBe(3);
    expect(hydratedMinuteView({ bidPeakAllPriceRankLimit: 4 }).bidPeakAllPriceRankLimit)
      .toBe(DEFAULT_PREFS.bidPeakAllPriceRankLimit);
    expect(hydratedMinuteView({ bidPeakVisibleMaxRankLimit: 4 }).bidPeakVisibleMaxRankLimit)
      .toBe(DEFAULT_PREFS.bidPeakVisibleMaxRankLimit);
  });

  it('post-touch and untraded rank limits default to 1', () => {
    expect(DEFAULT_PREFS.askPeakAllPriceRankLimit).toBe(1);
    expect(DEFAULT_PREFS.bidPeakAllPriceRankLimit).toBe(1);
    expect(DEFAULT_PREFS.askPeakUntradedRankLimit).toBe(1);
    expect(DEFAULT_PREFS.bidPeakUntradedRankLimit).toBe(1);
  });

  it('persists valid ask/bid untraded rank limits 1..3', () => {
    expect(hydratedMinuteView({ askPeakUntradedRankLimit: 1 }).askPeakUntradedRankLimit).toBe(1);
    expect(hydratedMinuteView({ askPeakUntradedRankLimit: 2 }).askPeakUntradedRankLimit).toBe(2);
    expect(hydratedMinuteView({ askPeakUntradedRankLimit: 3 }).askPeakUntradedRankLimit).toBe(3);
    expect(hydratedMinuteView({ bidPeakUntradedRankLimit: 1 }).bidPeakUntradedRankLimit).toBe(1);
    expect(hydratedMinuteView({ bidPeakUntradedRankLimit: 2 }).bidPeakUntradedRankLimit).toBe(2);
    expect(hydratedMinuteView({ bidPeakUntradedRankLimit: 3 }).bidPeakUntradedRankLimit).toBe(3);
  });

  it('falls back to defaults for invalid untraded rank limit values', () => {
    expect(hydratedMinuteView({ askPeakUntradedRankLimit: 0 }).askPeakUntradedRankLimit)
      .toBe(DEFAULT_PREFS.askPeakUntradedRankLimit);
    expect(hydratedMinuteView({ askPeakUntradedRankLimit: 4 }).askPeakUntradedRankLimit)
      .toBe(DEFAULT_PREFS.askPeakUntradedRankLimit);
    expect(hydratedMinuteView({ askPeakUntradedRankLimit: '2' as never }).askPeakUntradedRankLimit)
      .toBe(DEFAULT_PREFS.askPeakUntradedRankLimit);
    expect(hydratedMinuteView({ bidPeakUntradedRankLimit: 0 }).bidPeakUntradedRankLimit)
      .toBe(DEFAULT_PREFS.bidPeakUntradedRankLimit);
    expect(hydratedMinuteView({ bidPeakUntradedRankLimit: 4 }).bidPeakUntradedRankLimit)
      .toBe(DEFAULT_PREFS.bidPeakUntradedRankLimit);
    expect(hydratedMinuteView({ bidPeakUntradedRankLimit: '2' as never }).bidPeakUntradedRankLimit)
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
    const askOnly = hydratedMinuteView({ askPeakVisibleTimeCutoff: true });
    expect(askOnly.askPeakVisibleTimeCutoff).toBe(true);
    expect(askOnly.bidPeakVisibleTimeCutoff).toBe(false);

    const bidOnly = hydratedMinuteView({ bidPeakVisibleTimeCutoff: true });
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

describe('indicator-modal per-timeframe 버킷 (PR-B #699)', () => {
  beforeEach(() => {
    useChartPrefsStore.setState({
      ...DEFAULT_PREFS,
      indicatorModalByTimeframe: {},
      indicatorModalTimeframe: '1m',
    });
  });

  it('IM 키 쓰기는 ambient 봉 버킷에 기록되고 투영도 갱신된다', () => {
    useChartPrefsStore.getState().setNumericPref('askPeakVisibleMaxRankLimit', 3);
    useChartPrefsStore.getState().setToggle('askPeakIntraMax', true);
    const s = useChartPrefsStore.getState();
    expect(s.indicatorModalByTimeframe.minute).toMatchObject({
      askPeakVisibleMaxRankLimit: 3,
      askPeakIntraMax: true,
    });
    expect(s.askPeakVisibleMaxRankLimit).toBe(3);
    expect(s.askPeakIntraMax).toBe(true);
  });

  it('차트 전반 키 쓰기는 flat 그대로 (버킷 미기록)', () => {
    useChartPrefsStore.getState().setToggle('candleTooltipEnabled', false);
    const s = useChartPrefsStore.getState();
    expect(s.candleTooltipEnabled).toBe(false);
    expect(s.indicatorModalByTimeframe.minute).toBeUndefined();
  });

  it('봉 전환 시 해당 버킷으로 재투영된다 (1m~30m은 minute 공유)', () => {
    useChartPrefsStore.getState().setToggle('askPeakIntraMax', true); // minute
    useChartPrefsStore.getState().setIndicatorModalTimeframe('D');
    expect(useChartPrefsStore.getState().askPeakIntraMax).toBe(false); // D = 기본값
    useChartPrefsStore.getState().setNumericPref('bidPeakUntradedRankLimit', 3); // D 버킷
    useChartPrefsStore.getState().setIndicatorModalTimeframe('30m');
    const s = useChartPrefsStore.getState();
    expect(s.askPeakIntraMax).toBe(true);                 // minute 복원
    expect(s.bidPeakUntradedRankLimit).toBe(1);           // D 오버라이드는 minute 에 없음
    expect(s.indicatorModalByTimeframe.D?.bidPeakUntradedRankLimit).toBe(3);
  });

  it('resetIndicatorModalBucket 은 현재 봉 버킷만 비우고 차트 전반 flat 은 보존한다', () => {
    useChartPrefsStore.getState().setToggle('askPeakIntraMax', true); // minute IM
    useChartPrefsStore.getState().setToggle('candleTooltipEnabled', false); // 차트 전반 flat
    useChartPrefsStore.getState().setIndicatorModalTimeframe('D');
    useChartPrefsStore.getState().setToggle('bidPeakIntraMax', true); // D IM
    useChartPrefsStore.getState().resetIndicatorModalBucket();        // D IM 버킷만
    const s = useChartPrefsStore.getState();
    expect(s.indicatorModalByTimeframe.D).toBeUndefined();
    expect(s.indicatorModalByTimeframe.minute?.askPeakIntraMax).toBe(true);
    expect(s.bidPeakIntraMax).toBe(false);          // D 투영 = 기본값
    expect(s.candleTooltipEnabled).toBe(false);     // 차트 전반 flat 무손상
  });

  it('resetToDefaults 는 차트 전반 flat + 전 봉 버킷을 전부 비운다', () => {
    useChartPrefsStore.getState().setToggle('askPeakIntraMax', true); // minute IM
    useChartPrefsStore.getState().setIndicatorModalTimeframe('D');
    useChartPrefsStore.getState().setToggle('bidPeakIntraMax', true); // D IM
    useChartPrefsStore.getState().setToggle('candleTooltipEnabled', false); // 차트 전반
    useChartPrefsStore.getState().resetToDefaults();
    const s = useChartPrefsStore.getState();
    expect(s.indicatorModalByTimeframe).toEqual({});
    expect(s.candleTooltipEnabled).toBe(true);
  });

  it('저장 블롭에 indicatorModalByTimeframe 가 있으면 flat IM 값을 무시한다', () => {
    const byTimeframe = mergeIndicatorModalByTimeframe({
      askPeakIntraMax: true,                       // 구 flat — 무시돼야 함
      indicatorModalByTimeframe: {
        D: { bidPeakIntraMax: true, askPeakVisibleMaxRankLimit: 0 },
        bogus: { askPeakIntraMax: true },          // unknown profile → drop
      },
    });
    expect(byTimeframe).toEqual({
      D: { bidPeakIntraMax: true, askPeakVisibleMaxRankLimit: 0 },
    });
  });

  it('시드는 기본값과 다른 유효값만 minute 버킷에 남긴다', () => {
    const byTimeframe = mergeIndicatorModalByTimeframe({
      askPeakIntraMax: true,          // 기본 false 와 다름 → 시드
      askPeakShowAllPrices: true,     // 기본 true 와 동일 → 탈락
      surgeApproachPct: 999,          // 범위 밖 → 탈락
      candleTooltipEnabled: false,    // IM 키 아님 → 무시
    });
    expect(byTimeframe).toEqual({ minute: { askPeakIntraMax: true } });
  });
});
