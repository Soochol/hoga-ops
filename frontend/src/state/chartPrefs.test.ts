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
  mergeStudyIndicatorModal,
  CHART_PREFS_KEY,
} from './chartPrefsPersistence';
import { isIndicatorModalPrefKey, resolveIndicatorModalPrefs } from './chartPrefs';

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

  /**
   * ## 구 **방향 공용** 최대벽 키 → 계열 셋 (2026-08-25)
   *
   * 라벨·레전드 셀·화살표·MA 필터 둘(+기간)은 방향당 하나였다가 계열마다 갈렸다. 저장이
   * 기본값과의 sparse diff 라, 이 펼침이 없으면 **그 일곱을 손댔던 사용자만** 조용히
   * 기본값으로 돌아간다 — 증상은 "왜 갑자기 라벨이 다시 뜨지" 로 온다.
   *
   * 되돌아가는 쪽이 기본값(켜짐)이라 **테스트는 반드시 `false` 를 저장해 둔 상태로** 재야
   * 한다. `true` 로 재면 펼침이 없어도 기본값과 같아서 초록이다.
   */
  it('구 방향 공용 최대벽 키를 계열 셋으로 펼친다', () => {
    const view = hydratedMinuteView({
      indicatorModalByTimeframe: {
        minute: {
          askPeakLabelEnabled: false,
          askPeakAboveDailyMaPeriod: 60,
          bidPeakBelowMaEnabled: false,
        },
      },
    });
    for (const key of [
      'askPeakTradedLabelEnabled', 'askPeakUnreachedLabelEnabled', 'askPeakAllWallLabelEnabled',
    ] as const) {
      expect(view[key]).toBe(false);
    }
    for (const key of [
      'askPeakTradedAboveDailyMaPeriod',
      'askPeakUnreachedAboveDailyMaPeriod',
      'askPeakAllWallAboveDailyMaPeriod',
    ] as const) {
      expect(view[key]).toBe(60);
    }
    expect(view.bidPeakTradedBelowMaEnabled).toBe(false);
    expect(view.bidPeakAllWallBelowMaEnabled).toBe(false);
    // 손대지 않은 축은 그대로 기본값 — 펼침이 이웃 키까지 건드리지 않는다.
    expect(view.askPeakTradedLegendCellEnabled).toBe(DEFAULT_PREFS.askPeakTradedLegendCellEnabled);
    expect(view.askPeakTradedAboveMaPeriod).toBe(DEFAULT_PREFS.askPeakTradedAboveMaPeriod);
  });

  it('새 계열 키가 이미 저장돼 있으면 구 키가 그것을 덮지 않는다', () => {
    const view = hydratedMinuteView({
      indicatorModalByTimeframe: {
        minute: {
          askPeakLabelEnabled: false,
          // 사용자가 이미 계열별로 다시 켠 상태 — 구 키가 이겨서는 안 된다.
          askPeakAllWallLabelEnabled: true,
        },
      },
    });
    expect(view.askPeakTradedLabelEnabled).toBe(false);
    expect(view.askPeakAllWallLabelEnabled).toBe(true);
  });

  /** 계열별 키가 **indicator-modal 멤버십**에 들어가야 봉별 버킷에 저장되고 드로어의
   *  「현재 봉 초기화」가 함께 걷는다. 멤버십은 레지스트리의 `category` 에서 파생되므로
   *  엔트리에 그 필드를 빠뜨리면 여기서 걸린다 — 빠뜨리면 그 옵션만 조용히 전역 flat 로
   *  새고, 봉을 바꿔도 값이 따라오지 않는다. */
  it('계열별 최대벽 키는 indicator-modal 스코프에 속한다', () => {
    for (const key of [
      'askPeakTradedLabelEnabled',
      'askPeakUnreachedRankArrowEnabled',
      'askPeakAllWallAboveDailyMaEnabled',
      'bidPeakTradedBelowMaEnabled',
      'bidPeakAllWallLegendCellEnabled',
      'askPeakTradedAboveMaPeriod',
      'bidPeakUnreachedBelowDailyMaPeriod',
    ]) {
      expect(isIndicatorModalPrefKey(key)).toBe(true);
    }
  });

  it('uses the new key, not replay.tabs.*', () => {
    expect(CHART_PREFS_KEY).toBe('hoga.chart.prefs.v1');
    expect(CHART_PREFS_KEY.includes('replay')).toBe(false);
  });

  it('`/study` 키가 없으면 `/live` 에서 즉시 시드한다(깊은 사본)', () => {
    // 게으른 폴백이면 `/study` 가 첫 편집 전까지 `/live` 를 따라다닌다(ADR-0146).
    const live = { minute: { surgeMarkerEnabled: false } } as const;
    const merged = mergeStudyIndicatorModal({}, live);

    expect(merged.minute?.surgeMarkerEnabled).toBe(false);
    expect(merged.minute).not.toBe(live.minute); // 버킷 참조를 공유하지 않는다
  });

  it('`/study` 키가 비어 있으면 그대로 빈 세트다 — 시드로 덮지 않는다', () => {
    const merged = mergeStudyIndicatorModal(
      { studyIndicatorModalByTimeframe: {} },
      { minute: { surgeMarkerEnabled: false } },
    );
    expect(merged).toEqual({});
  });
});

describe('candleTooltipEnabled 토글', () => {
  it('기본값 false', () => {
    expect(DEFAULT_PREFS.candleTooltipEnabled).toBe(false);
  });

  it('persist 된 true 를 보존', () => {
    expect(mergePrefs({ candleTooltipEnabled: true }).candleTooltipEnabled).toBe(true);
  });

  it('없으면 기본값(false) 으로 폴백', () => {
    expect(mergePrefs({}).candleTooltipEnabled).toBe(false);
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

import { CHART_TOGGLES, CHART_LINE_STYLES, CHART_NUMERIC_PREFS, categoryOf, gatedByOf } from './chartPrefs';

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
  it('label display toggles default on and persist false', () => {
    const ask = CHART_TOGGLES.find((t) => t.key === 'askPeakTradedLabelEnabled');
    const bid = CHART_TOGGLES.find((t) => t.key === 'bidPeakTradedLabelEnabled');

    expect(DEFAULT_PREFS.askPeakTradedLabelEnabled).toBe(true);
    expect(DEFAULT_PREFS.bidPeakTradedLabelEnabled).toBe(true);
    expect(ask?.label).toBe('최대벽 라벨 표시');
    expect(bid?.label).toBe('최대벽 라벨 표시');
    expect(categoryOf(ask!)).toBe('indicator-modal');
    expect(categoryOf(bid!)).toBe('indicator-modal');
    expect(hydratedMinuteView({ askPeakTradedLabelEnabled: false }).askPeakTradedLabelEnabled)
      .toBe(false);
    expect(hydratedMinuteView({ bidPeakTradedLabelEnabled: false }).bidPeakTradedLabelEnabled)
      .toBe(false);
  });

  it('rank limit defaults to 1 and persists valid 1..3 values', () => {
    expect(DEFAULT_PREFS.askPeakAllPriceRankLimit).toBe(1);
    expect(hydratedMinuteView({ askPeakAllPriceRankLimit: 2 }).askPeakAllPriceRankLimit).toBe(2);
    expect(hydratedMinuteView({ askPeakAllPriceRankLimit: 4 }).askPeakAllPriceRankLimit)
      .toBe(DEFAULT_PREFS.askPeakAllPriceRankLimit);
  });

  it('bid rank limits default to 1 and persist valid 1..3 values', () => {
    expect(DEFAULT_PREFS.bidPeakAllPriceRankLimit).toBe(1);
    expect(hydratedMinuteView({ bidPeakAllPriceRankLimit: 2 }).bidPeakAllPriceRankLimit).toBe(2);
    expect(hydratedMinuteView({ bidPeakAllPriceRankLimit: 4 }).bidPeakAllPriceRankLimit)
      .toBe(DEFAULT_PREFS.bidPeakAllPriceRankLimit);
  });

  it('touched-wall rank limits default to 1', () => {
    // ⚠ 키 이름의 `AllPrice` 는 **체결된 벽** 개수다(ADR-0084 잔재; ADR-0156 이 형제
    // `*AllPriceColor` = 미체결 선 색을 지우면서 이름만 남았다).
    expect(DEFAULT_PREFS.askPeakAllPriceRankLimit).toBe(1);
    expect(DEFAULT_PREFS.bidPeakAllPriceRankLimit).toBe(1);
  });




  it('labels the touched-wall rank prefs and keeps no untouched sibling (ADR-0156)', () => {
    const askRank = CHART_NUMERIC_PREFS.find((p) => p.key === 'askPeakAllPriceRankLimit');
    const bidRank = CHART_NUMERIC_PREFS.find((p) => p.key === 'bidPeakAllPriceRankLimit');

    expect(askRank?.label).toBe('체결된 벽 표시 개수');
    expect(bidRank?.label).toBe('체결된 벽 표시 개수');
    expect(askRank).toMatchObject({ category: 'indicator-modal' });
    expect(bidRank).toMatchObject({ category: 'indicator-modal' });
    // 미체결 계열은 pref 표에서 사라졌다 — 남아 있으면 UI 가 죽은 항목을 렌더한다.
    expect(CHART_NUMERIC_PREFS.some((p) => p.key.endsWith('UntradedRankLimit'))).toBe(false);
    expect(CHART_TOGGLES.some((t) => t.key.endsWith('PeakShowAllPrices'))).toBe(false);
  });
});

describe('bid peak toggles', () => {
  it('defaults and belongs to the indicator modal', () => {
    const intra = CHART_TOGGLES.find((t) => t.key === 'bidPeakIntraMax');

    expect(intra?.default).toBe(false);
    expect(categoryOf(intra!)).toBe('indicator-modal');
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
    useChartPrefsStore.getState().setNumericPref('askPeakAllPriceRankLimit', 3);
    useChartPrefsStore.getState().setToggle('askPeakIntraMax', true);
    const s = useChartPrefsStore.getState();
    expect(s.indicatorModalByTimeframe.minute).toMatchObject({
      askPeakAllPriceRankLimit: 3,
      askPeakIntraMax: true,
    });
    expect(s.askPeakAllPriceRankLimit).toBe(3);
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
    useChartPrefsStore.getState().setNumericPref('bidPeakAllPriceRankLimit', 3); // D 버킷
    useChartPrefsStore.getState().setIndicatorModalTimeframe('30m');
    const s = useChartPrefsStore.getState();
    expect(s.askPeakIntraMax).toBe(true);                 // minute 복원
    expect(s.bidPeakAllPriceRankLimit).toBe(1);           // D 오버라이드는 minute 에 없음
    expect(s.indicatorModalByTimeframe.D?.bidPeakAllPriceRankLimit).toBe(3);
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
    useChartPrefsStore.getState().setToggle('candleTooltipEnabled', true); // 차트 전반
    useChartPrefsStore.getState().resetToDefaults();
    const s = useChartPrefsStore.getState();
    expect(s.indicatorModalByTimeframe).toEqual({});
    expect(s.candleTooltipEnabled).toBe(false);
  });

  it('저장 블롭에 indicatorModalByTimeframe 가 있으면 flat IM 값을 무시한다', () => {
    const byTimeframe = mergeIndicatorModalByTimeframe({
      askPeakIntraMax: true,                       // 구 flat — 무시돼야 함
      indicatorModalByTimeframe: {
        D: { bidPeakIntraMax: true, askPeakAllPriceRankLimit: 2 },
        bogus: { askPeakIntraMax: true },          // unknown profile → drop
      },
    });
    expect(byTimeframe).toEqual({
      D: { bidPeakIntraMax: true, askPeakAllPriceRankLimit: 2 },
    });
  });

  it('시드는 기본값과 다른 유효값만 minute 버킷에 남긴다', () => {
    const byTimeframe = mergeIndicatorModalByTimeframe({
      askPeakIntraMax: true,          // 기본 false 와 다름 → 시드
      askPeakLabelEnabled: true,      // 기본 true 와 동일 → 탈락
      surgeApproachPct: 999,          // 범위 밖 → 탈락
      candleTooltipEnabled: false,    // IM 키 아님 → 무시
    });
    expect(byTimeframe).toEqual({ minute: { askPeakIntraMax: true } });
  });
});

describe('극값 가격선 설정', () => {
  it('고가·저가 가격선은 **각각 독립 토글**이고 둘 다 기본 OFF', () => {
    // 기본 OFF 인 이유: 라벨(`highLowLabelsEnabled`)은 기본 ON 이라 이미 켜져 있는
    // 사용자 화면에 선이 저절로 생기면 안 된다. 옵트인이다.
    expect(DEFAULT_PREFS.highLowHighLineEnabled).toBe(false);
    expect(DEFAULT_PREFS.highLowLowLineEnabled).toBe(false);
  });

  it('둘 다 고저 극값 라벨의 하위 토글(enabledBy)이고 chart 카테고리', () => {
    for (const key of ['highLowHighLineEnabled', 'highLowLowLineEnabled'] as const) {
      const t = CHART_TOGGLES.find((x) => x.key === key);
      expect(t).toBeDefined();
      expect(gatedByOf(t!)).toBe('highLowLabelsEnabled');
      expect(categoryOf(t!)).toBe('chart');
    }
  });

  it('부모(고저 극값 라벨)는 하위를 갖되 스스로는 최상위', () => {
    // 중첩은 한 단계까지다 — 부모가 또 누군가의 하위면 IndicatorPrefRows 의
    // "부모 아래 한 번만 렌더" 전제가 깨진다.
    const parent = CHART_TOGGLES.find((t) => t.key === 'highLowLabelsEnabled');
    expect(gatedByOf(parent!)).toBeUndefined();
  });

  it('persist 된 값 보존', () => {
    expect(hydratedMinuteView({ highLowHighLineEnabled: true }).highLowHighLineEnabled).toBe(true);
    expect(hydratedMinuteView({ highLowLowLineEnabled: true }).highLowLowLineEnabled).toBe(true);
  });
});

describe('이전일 고저선 설정', () => {
  it('이전일 고가·저가선도 각각 독립 토글이고 둘 다 기본 OFF', () => {
    expect(DEFAULT_PREFS.highLowPriorHighLineEnabled).toBe(false);
    expect(DEFAULT_PREFS.highLowPriorLowLineEnabled).toBe(false);
  });

  it('고저 극값 라벨의 하위 토글이고 chart 카테고리', () => {
    for (const key of ['highLowPriorHighLineEnabled', 'highLowPriorLowLineEnabled'] as const) {
      const t = CHART_TOGGLES.find((x) => x.key === key);
      expect(gatedByOf(t!)).toBe('highLowLabelsEnabled');
      expect(categoryOf(t!)).toBe('chart');
    }
  });
});

describe('CHART_LINE_STYLES (선 색·두께 레지스트리)', () => {
  it('수평선 4종이 각자 자기 토글에 게이트된다', () => {
    expect(CHART_LINE_STYLES.map((d) => [d.key, d.enabledBy])).toEqual([
      ['highLowHighLine', 'highLowHighLineEnabled'],
      ['highLowLowLine', 'highLowLowLineEnabled'],
      ['highLowPriorHighLine', 'highLowPriorHighLineEnabled'],
      ['highLowPriorLowLine', 'highLowPriorLowLineEnabled'],
    ]);
  });

  it("색 기본값은 '' (=방향 토큰 추종), 두께 기본값은 1", () => {
    // hex 를 기본값으로 박으면 테마 전환을 따라가지 않는다 — `''` 여야 draw 가
    // 그 프레임의 테마로 푼다. 이 단언이 그 규약을 고정한다.
    for (const d of CHART_LINE_STYLES) {
      expect(DEFAULT_PREFS[`${d.key}Color` as keyof typeof DEFAULT_PREFS]).toBe('');
      expect(DEFAULT_PREFS[`${d.key}Width` as keyof typeof DEFAULT_PREFS]).toBe(1);
    }
  });

  it('label 은 **선 이름**이라 "스타일" 을 포함하지 않는다', () => {
    // 행 제목은 LineStyleRow 가 `<label> 스타일` 로 조립하고, MAStylePicker 는
    // aria-label 에 " 스타일 선택" 을 덧붙인다 — 여기 넣으면 "… 스타일 스타일 선택".
    for (const d of CHART_LINE_STYLES) {
      expect(d.label).not.toContain('스타일');
    }
  });

  it('고가 계열은 up, 저가 계열은 down 방향', () => {
    expect(CHART_LINE_STYLES.filter((d) => d.direction === 'up').map((d) => d.key))
      .toEqual(['highLowHighLine', 'highLowPriorHighLine']);
    expect(CHART_LINE_STYLES.filter((d) => d.direction === 'down').map((d) => d.key))
      .toEqual(['highLowLowLine', 'highLowPriorLowLine']);
  });

  it('persist: 색·두께가 살아 돌아오고, 무효값은 기본값으로 떨어진다', () => {
    const v = hydratedMinuteView({
      highLowHighLineColor: '#00ff00',
      highLowHighLineWidth: 3,
      highLowLowLineColor: 'not-a-color',
      highLowLowLineWidth: 9,
    });
    expect(v.highLowHighLineColor).toBe('#00FF00'); // 대문자 정규화
    expect(v.highLowHighLineWidth).toBe(3);
    expect(v.highLowLowLineColor).toBe('');
    expect(v.highLowLowLineWidth).toBe(1);
  });

  it("persist: 빈 문자열은 **유효한 저장값**이다 (= 고르지 않음)", () => {
    // 색을 고른 뒤 기본으로 되돌린 상태. falsy 라고 걸러 내면 이전 hex 가 되살아난다.
    expect(hydratedMinuteView({ highLowPriorHighLineColor: '' }).highLowPriorHighLineColor).toBe('');
  });
});
