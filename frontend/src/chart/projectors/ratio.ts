import {
  BaselineSeries,
  type AutoscaleInfoProvider,
  type BaselineData,
  type LineWidth,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useMemo } from 'react';
import type { RangeBundle, QuoteRatioPoint } from '../../api/types';
import type { BrokerLateEntrySideMode } from '../../state/liveIndicatorsPersistence';
import { useWindowIndicator, useWindowScopeId } from '../../live/workspace/windowView';
import { type VirtualAxis } from '../../util/virtualAxis';
import { isSyntheticHogaGapPoint } from '../util/hogaGapHide';
import { quoteImbalance } from '../../util/imbalance';
import { resolveTokensThemed } from '../../util/tokens';
import { useShallow } from 'zustand/react/shallow';
import { useActivePrefs } from '../../state/chartPrefs';
import type { PaneSpec } from '../RangeSeriesPane';
import { addZeroBaselineGuide } from '../util/zeroBaseline';
import { isAuctionHidden, isExcludedQuoteBucket, BASELINE_HIDDEN_COLORS, maskOutgoingConnector } from '../util/auctionHide';
import { makePastCachedProjector } from './pastCachedProjector';
import {
  registerFlagLegendValues,
  type FlagLegendValueCell,
} from '../../live/indicators/flagLegendValueRegistry';
import { legendCursorDate } from '../../live/peakLegendValues';
import type { BrokerLateEntryMarkerPoint } from './brokerLateEntryMarkers';
import { makeCachedBrokerLateEntryProjector } from './brokerLateEntryMarkers';
import { quoteRatioPointsForBundle, quoteRatioPointsForSlice } from './quoteRatioPoints';

// Colors are applied at series-options level (thunked below), not per data
// point — projectRatioPoints emits value-only, so ratioCachedData needs no
// theme key.
const TOKEN_SPEC = {
  // KRX 컨벤션: 매수=상승=빨강, 매도=하락=파랑. RatioPane은 price-direction
  // 토큰을 직접 차용해 의미 충돌 없음 (도서 압력 부호와 가격 방향이 정렬됨).
  ratioBid: ['--price-up', '#F04452'],
  ratioAsk: ['--price-down', '#3485FA'],
  baseline: ['--fg-dimmer', '#63636F'],
} as const;

/**
 * Convert a `#RRGGBB` hex string to `rgba(R, G, B, a)`. Used to derive
 * the soft gradient fill colors for `BaselineSeries`' top/bottom areas
 * from the solid token colors.
 */
function rgba(hex: string, a: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

const priceFormat = {
  type: 'custom' as const,
  formatter: (v: number) => {
    if (Math.abs(v) < 0.005) return '0';
    return (1 + Math.abs(v)).toFixed(1);
  },
  minMove: 0.01,
};

const RATIO_AUTOSCALE_EPSILON = 0.01;

const includeZeroAutoscale: AutoscaleInfoProvider = (original) => {
  const res = original();
  if (!res?.priceRange) return res;
  res.priceRange.minValue = Math.min(res.priceRange.minValue, 0);
  res.priceRange.maxValue = Math.max(res.priceRange.maxValue, 0);
  if (res.priceRange.minValue === res.priceRange.maxValue) {
    res.priceRange.minValue -= RATIO_AUTOSCALE_EPSILON;
    res.priceRange.maxValue += RATIO_AUTOSCALE_EPSILON;
  }
  return res;
};

export type RatioPaneContext = {
  auctionWindowMask: boolean;
  outlierFilterEnabled: boolean;
  outlierThreshold: number;
  /** ratioIntraMax — 호가비 분봉 내 |불균형| 극값(부호 유지) 기준. 미지정 = 종가. */
  intraMax?: boolean;
  brokerLateEntryEnabled: boolean;
  /** 눈(숨김) — 마커 그리기만 끄고 레전드 값 계산은 유지. 미지정 = 표시. */
  brokerLateEntryHidden?: boolean;
  brokerLateEntrySideMode: BrokerLateEntrySideMode;
  brokerLateEntryBuyColor: string;
  brokerLateEntrySellColor: string;
  /** 이 pane 을 그리는 차트 창(멀티창 #706). 레전드 값 provider 등록 스코프로만
   *  쓰이고 투영 자체에는 관여하지 않는다 — 그래서 optional(순수 투영 테스트/`/study`
   *  는 생략 = 전역 스코프). */
  windowId?: string | null;
};

export function projectRatio(
  bundle: RangeBundle,
  axis: VirtualAxis,
  ctx: RatioPaneContext,
): BaselineData<Time>[] {
  return projectRatioPoints(quoteRatioPointsForBundle(bundle), axis, ctx);
}

/** Points-array variant of {@link projectRatio} — projects an arbitrary slice
 * of quote_ratio points (not the whole bundle). Extracted so the /live tick
 * path can project the immutable past slice once (cached) and only the live
 * today slice per tick. Hoga-gap sentinels are expanded per slice by the cached
 * spec path; if today's first emitted point is synthetic, makePastCachedProjector
 * patches the cached past tail so the split output stays byte-identical to full
 * projection. */
export function projectRatioPoints(
  points: readonly QuoteRatioPoint[],
  axis: VirtualAxis,
  ctx: RatioPaneContext,
): BaselineData<Time>[] {
  const out: BaselineData<Time>[] = [];
  for (const p of points) {
    if (!axis.contains(p.t)) continue;
    const time = (axis.toVirtual(p.t) / 1000) as UTCTimestamp;
    if (isSyntheticHogaGapPoint(p)) {
      maskOutgoingConnector(out, BASELINE_HIDDEN_COLORS);
      out.push({ time, value: 0, ...BASELINE_HIDDEN_COLORS });
      continue;
    }
    // Auction-window hide (ADR-0029, util/auctionHide.ts). Skipping the
    // outlier check is intentional: a hidden point has no value to clamp.
    // Break the connector from the last pre-auction point so the baseline
    // doesn't slope into the window.
    // 시간 마스크(마감 동시호가) OR 구조 센티넬(장중 VI 포함, (0,0)) — ADR-0062 v2.
    if (
      isAuctionHidden(axis, ctx.auctionWindowMask, p.t) ||
      isExcludedQuoteBucket(ctx.auctionWindowMask, p.bid_total, p.ask_total)
    ) {
      maskOutgoingConnector(out, BASELINE_HIDDEN_COLORS);
      out.push({ time, value: 0, ...BASELINE_HIDDEN_COLORS });
      continue;
    }
    // A fully-auction bucket is excluded upstream by emitting (0,0) totals
    // (bucketHogaSeries / query_bucketed_ratio, ADR-0062). No NaN guard is
    // needed here: quoteImbalance returns 0 for a degenerate (≤0) book
    // (util/imbalance.ts), so an excluded bucket renders flat at 0 — matching
    // the 총잔량 pane — in both the mask-ON and mask-OFF views.
    const raw = ctx.intraMax
      ? quoteImbalance(p.imb_max_bid, p.imb_max_ask)
      : quoteImbalance(p.bid_total, p.ask_total);
    // Outlier clamp (ADR-0026): mask the value to 0 when the chart-label
    // magnitude crosses the user threshold. The point stays on the time
    // axis at value=0 — outliers are scattered and have no natural break.
    const isExtreme =
      ctx.outlierFilterEnabled && 1 + Math.abs(raw) >= ctx.outlierThreshold;
    out.push({ time, value: isExtreme ? 0 : raw });
  }
  return out;
}

// Single selector + useShallow so the returned object reference is stable
// when none of the three fields change. Without useShallow, every call to
// this hook returns a fresh object literal — and RangeSeriesPane's data
// effect (`useEffect(..., [bundle, axis, ctx, spec])`) re-runs every
// render, whose setData triggers chart range subscribers that round-trip
// into React state, producing "Maximum update depth exceeded". Same
// pattern as useCursor.ts.
const useRatioContext = (): RatioPaneContext => {
  const chartPrefs = useActivePrefs(
    useShallow((p) => ({
      auctionWindowMask: p.auctionWindowMask,
      outlierFilterEnabled: p.ratioOutlierFilterEnabled,
      outlierThreshold: p.ratioOutlierThreshold,
      intraMax: p.ratioIntraMax,
    })),
  );
  // 창-스코프 절단(ADR-0119 C2c-2a) — 필드별 구독으로 전역 폴백 입도 보존.
  const brokerLateEntryEnabled = useWindowIndicator((s) => s.brokerLateEntryEnabled);
  const brokerLateEntryHidden = useWindowIndicator((s) => s.brokerLateEntryHidden);
  const brokerLateEntrySideMode = useWindowIndicator((s) => s.brokerLateEntrySideMode);
  const brokerLateEntryBuyColor = useWindowIndicator((s) => s.brokerLateEntryBuyColor);
  const brokerLateEntrySellColor = useWindowIndicator((s) => s.brokerLateEntrySellColor);
  // 레전드 값 provider 등록 스코프(멀티창) — 창 수명 동안 불변이라 ctx identity 를
  // 흔들지 않는다. 컨텍스트만 읽으므로 전역 스토어 구독도 늘지 않는다.
  const windowId = useWindowScopeId();
  const brokerPrefs = useMemo(
    () => ({
      brokerLateEntryEnabled,
      brokerLateEntryHidden,
      brokerLateEntrySideMode,
      brokerLateEntryBuyColor,
      brokerLateEntrySellColor,
      windowId,
    }),
    [brokerLateEntryEnabled, brokerLateEntryHidden, brokerLateEntrySideMode,
      brokerLateEntryBuyColor, brokerLateEntrySellColor, windowId],
  );

  return useMemo(
    () => ({
      ...chartPrefs,
      ...brokerPrefs,
    }),
    [
      chartPrefs.auctionWindowMask,
      chartPrefs.outlierFilterEnabled,
      chartPrefs.outlierThreshold,
      chartPrefs.intraMax,
      brokerPrefs.brokerLateEntryEnabled,
      brokerPrefs.brokerLateEntryHidden,
      brokerPrefs.brokerLateEntrySideMode,
      brokerPrefs.brokerLateEntryBuyColor,
      brokerPrefs.brokerLateEntrySellColor,
      brokerPrefs.windowId,
    ],
  );
};

// 틱당 풀-배열 재투영 제거(P0): 과거 슬라이스 투영은 캐시, 당일만 재투영. 출력은
// projectRatio와 바이트 동일(pastCachedProjector.test.ts). 모듈 레벨 1개 인스턴스 —
// 내부 캐시는 axis 식별자별 WeakMap이라 /live 단일 차트에서 안전.
const ratioCachedData = makePastCachedProjector(projectRatioPoints, (b) => b.quote_ratio.points, {
  shouldPatchBoundary: isSyntheticHogaGapPoint,
  patchPastTail: BASELINE_HIDDEN_COLORS,
}, quoteRatioPointsForSlice);

// 거래원 지각진입 라벨 마커도 과거/당일 분리 캐시 — labelMarkers 는 SSE 틱마다 실행되고
// 매번 전체 ratio points 에 sentinel 정렬(O(n log n))을 재지불했다. 모듈 레벨 1개 인스턴스.
const brokerLateEntryMarkersCached = makeCachedBrokerLateEntryProjector();

// 신규 거래원 등장 레전드 값 — 커서 거래일의 매수/매도 마커 수. labelMarkers 가
// 계산한 마커를 그대로 세므로 그리기와 값이 어긋날 수 없다.
function brokerLegendCells(
  points: readonly BrokerLateEntryMarkerPoint[],
  axis: VirtualAxis,
  cursorTimeSec: number | null,
): FlagLegendValueCell[] {
  if (points.length === 0) return [];
  const date = legendCursorDate(axis, cursorTimeSec);
  if (date === null) return [];
  let buyCount = 0;
  let sellCount = 0;
  let buyColor: string | undefined;
  let sellColor: string | undefined;
  for (const p of points) {
    const idx = axis.findByVirtual((p.time as unknown as number) * 1000);
    if (idx < 0 || axis.segments[idx]?.date !== date) continue;
    if (p.side === 'buy') {
      buyCount += 1;
      buyColor = p.color;
    } else {
      sellCount += 1;
      sellColor = p.color;
    }
  }
  const cells: FlagLegendValueCell[] = [];
  if (buyCount > 0) cells.push({ key: 'ble-buy', label: '매수', color: buyColor, value: `${buyCount}건` });
  if (sellCount > 0) cells.push({ key: 'ble-sell', label: '매도', color: sellColor, value: `${sellCount}건` });
  return cells;
}

export const RATIO_SPEC = {
  name: 'ratio' as const,
  live: true, // reads quote_ratio (SSE-derived) → fed the live bundle on /live
  stretch: 0.4,
  legendToggleKey: 'ratioEnabled',
  useContext: useRatioContext,
  series: [
    {
      type: BaselineSeries,
      // No swatch: the baseline is bi-color (red above / blue below the zero
      // baseline), so a single color would mislead. Value format mirrors the
      // pane's price axis (magnitude, sign shown by the chart's color).
      legend: { label: '호가비', format: priceFormat.formatter },
      options: () => {
        const { ratioBid, ratioAsk } = resolveTokensThemed(TOKEN_SPEC);
        return {
          baseValue: { type: 'price', price: 0 },
          // Gradient relative to the data range, not the full pane. Without this,
          // when data hugs the baseline (small imbalances near 0), the fill
          // sits in the "near-baseline" alpha (0.1) zone and reads as invisible.
          // With true, the saturated fill (0.55) is concentrated at the data
          // peaks where the user actually looks.
          relativeGradient: true,
          // BaselineSeries' relative gradient expects the zero baseline to be
          // inside the autoscaled range. Study snapshots can legitimately contain
          // a one-sided ratio run, so merge zero into the default range to keep
          // gradient stops finite while preserving data-driven scale.
          autoscaleInfoProvider: includeZeroAutoscale,
          topLineColor: ratioAsk,
          topFillColor1: rgba(ratioAsk, 0.55),
          topFillColor2: rgba(ratioAsk, 0.1),
          bottomLineColor: ratioBid,
          bottomFillColor1: rgba(ratioBid, 0.1),
          bottomFillColor2: rgba(ratioBid, 0.55),
          // Bumped from 1.4 → 3: at the typical pane height (~62px) with
          // mostly small-magnitude imbalance values plus rare outlier spikes
          // that dominate the autoscale, hairlines disappear into the baseline.
          // A 3px stroke survives both the small-magnitude near-baseline runs
          // and the cross-day extreme spikes that compress the visible range.
          lineWidth: 3 satisfies LineWidth,
          // Suppress the library-default horizontal line + right-axis chip at the
          // latest value. Analysts read the latest ratio via crosshair.
          priceLineVisible: false,
          lastValueVisible: false,
          priceFormat,
        };
      },
      data: ratioCachedData,
      labelMarkers: (bundle, axis, ctx) => {
        // enabled면 항상 계산해 레전드 스냅샷 갱신 — 눈(hidden)은 그리기만 끈다.
        const points = ctx.brokerLateEntryEnabled
          ? brokerLateEntryMarkersCached(bundle, axis, {
              auctionWindowMask: ctx.auctionWindowMask,
              outlierFilterEnabled: ctx.outlierFilterEnabled,
              outlierThreshold: ctx.outlierThreshold,
              intraMax: ctx.intraMax,
              sideMode: ctx.brokerLateEntrySideMode,
              buyColor: ctx.brokerLateEntryBuyColor,
              sellColor: ctx.brokerLateEntrySellColor,
            })
          : [];
        // 레전드 값 provider 를 이 창 스코프에 재등록 — points/axis 를 클로저에 담아
        // 모듈 전역 스냅샷을 없앴다(멀티창에서 마지막 창이 전역 값을 덮어쓰던 원인).
        // 비반응형 Map 이라 이 갱신은 레전드 재렌더를 유발하지 않는다(P1 유지);
        // 레전드는 크로스헤어/dataEpoch 시점에 최신 provider 를 lazy 하게 읽는다.
        registerFlagLegendValues(ctx.windowId ?? null, 'broker-late-entry', (cursorTimeSec) =>
          brokerLegendCells(points, axis, cursorTimeSec),
        );
        return ctx.brokerLateEntryHidden ? [] : points;
      },
      afterAdd: (series) => {
        // 0-baseline reference line. Drawn explicitly because BaselineSeries
        // switches color at baseValue but does not paint a visible line there.
        // Color is --fg-dimmer (neutral) so it reads as a reference, not data.
        addZeroBaselineGuide(series, resolveTokensThemed(TOKEN_SPEC).baseline);
      },
    },
  ],
} satisfies PaneSpec<RatioPaneContext>;
