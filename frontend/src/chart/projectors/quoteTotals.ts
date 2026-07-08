import {
  LineSeries,
  type LineData,
  type UTCTimestamp,
  type Time,
} from 'lightweight-charts';
import { useShallow } from 'zustand/react/shallow';
import type { RangeBundle, QuoteRatioPoint } from '../../api/types';
import { type VirtualAxis } from '../../util/virtualAxis';
import { isSyntheticHogaGapPoint } from '../util/hogaGapHide';
import { resolveTokens } from '../../util/tokens';
import { useActivePrefs } from '../../state/chartPrefs';
import type { PaneSpec } from '../RangeSeriesPane';
import type { SurgeMarkerPoint } from '../SurgeMarkersPrimitive';
import { isAuctionHidden, LINE_HIDDEN_COLOR, maskOutgoingConnector } from '../util/auctionHide';
import { makePastCachedProjector } from './pastCachedProjector';
import { quoteRatioPointsForBundle, quoteRatioPointsForSlice } from './quoteRatioPoints';
import { detectSurgeSide } from '../surge/detectSurges';

const TOKEN_SPEC = {
  bid: ['--price-up', '#F04452'],   // 매수 호가 총합 (KRX 빨강)
  ask: ['--price-down', '#3485FA'], // 매도 호가 총합 (KRX 파랑)
} as const;

const { bid, ask } = resolveTokens(TOKEN_SPEC);

const priceFormat = {
  type: 'custom' as const,
  formatter: (v: number) => Math.round(v).toLocaleString('ko-KR'),
  minMove: 1,
};

export function projectBid(
  bundle: RangeBundle,
  axis: VirtualAxis,
  auctionWindowMask: boolean,
): LineData<Time>[] {
  return projectBidPoints(quoteRatioPointsForBundle(bundle), axis, auctionWindowMask);
}

/** Points-array variant of {@link projectBid} — see projectRatioPoints /
 * makePastCachedProjector for the /live past-cache rationale and synthetic
 * hoga-gap boundary patch. */
export function projectBidPoints(
  points: readonly QuoteRatioPoint[],
  axis: VirtualAxis,
  auctionWindowMask: boolean,
  intraMax = false,
): LineData<Time>[] {
  const out: LineData<Time>[] = [];
  for (const p of points) {
    if (!axis.contains(p.t)) continue;
    const time = (axis.toVirtual(p.t) / 1000) as UTCTimestamp;
    if (isSyntheticHogaGapPoint(p)) {
      maskOutgoingConnector(out, LINE_HIDDEN_COLOR);
      out.push({ time, value: 0, ...LINE_HIDDEN_COLOR });
      continue;
    }
    // Auction-window hide (ADR-0029, util/auctionHide.ts). Break the connector
    // from the last pre-auction point so the line doesn't slope into the window.
    if (isAuctionHidden(axis, auctionWindowMask, p.t)) {
      maskOutgoingConnector(out, LINE_HIDDEN_COLOR);
      out.push({ time, value: 0, ...LINE_HIDDEN_COLOR });
      continue;
    }
    out.push({
      time,
      value: intraMax ? p.bid_max : p.bid_total,
      color: bid,
    });
  }
  return out;
}

export function projectAsk(
  bundle: RangeBundle,
  axis: VirtualAxis,
  auctionWindowMask: boolean,
): LineData<Time>[] {
  return projectAskPoints(quoteRatioPointsForBundle(bundle), axis, auctionWindowMask);
}

/** Points-array variant of {@link projectAsk}. */
export function projectAskPoints(
  points: readonly QuoteRatioPoint[],
  axis: VirtualAxis,
  auctionWindowMask: boolean,
  intraMax = false,
): LineData<Time>[] {
  const out: LineData<Time>[] = [];
  for (const p of points) {
    if (!axis.contains(p.t)) continue;
    const time = (axis.toVirtual(p.t) / 1000) as UTCTimestamp;
    if (isSyntheticHogaGapPoint(p)) {
      maskOutgoingConnector(out, LINE_HIDDEN_COLOR);
      out.push({ time, value: 0, ...LINE_HIDDEN_COLOR });
      continue;
    }
    if (isAuctionHidden(axis, auctionWindowMask, p.t)) {
      maskOutgoingConnector(out, LINE_HIDDEN_COLOR);
      out.push({ time, value: 0, ...LINE_HIDDEN_COLOR });
      continue;
    }
    out.push({
      time,
      value: intraMax ? p.ask_max : p.ask_total,
      color: ask,
    });
  }
  return out;
}

export type QuoteTotalsCtx = {
  auctionMask: boolean;
  intraMax: boolean;
  surgeEnabled: boolean;
  surgeApproachPct: number;
  surgeRearmPct: number;
  /** 마커 표시 시작 시각(HHMM, 예 930=09:30). 이 시각 이전의 급증은 표시만 가린다 — 알고리즘(running
   *  peak·재무장)은 장 시작부터 계속 진행하므로 detectSurgeSide에는 넘기지 않고 프로젝터에서 필터링. */
  surgeStartHHMM: number;
};

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
/** t(ms epoch)의 KST 자정 기준 분(0–1439). 거래일 경계와 무관한 순수 함수라 과거/당일 청크별로
 *  따로 적용해도 split-cache 출력 동일성을 깨지 않는다. */
const kstMinuteOfDay = (t: number): number => Math.floor((t + KST_OFFSET_MS) / 60_000) % 1440;
/** HHMM 정수(예 930)를 자정 기준 분으로. 분 자리(00–59) 벗어난 값은 자연 환산(960→10:00). */
const hhmmToMinute = (hhmm: number): number => Math.floor(hhmm / 100) * 60 + (hhmm % 100);

// useShallow: object literal reference stays stable when the fields don't change
// → makePastCachedProjector's ctx-identity cache key (via bidCachedData's
// ctx.auctionMask) and React.memo both hold. Same pattern as ratio.ts / fillStrength.ts.
const useQuoteTotalsContext = (): QuoteTotalsCtx =>
  useActivePrefs(
    useShallow((p) => ({
      auctionMask: p.auctionWindowMask,
      intraMax: p.quoteTotalsIntraMax,
      surgeEnabled: p.surgeMarkerEnabled,
      surgeApproachPct: p.surgeApproachPct,
      surgeRearmPct: p.surgeRearmPct,
      surgeStartHHMM: p.surgeStartHHMM,
    })),
  );

/** 한 side의 급증 마커 프로젝터(per-side, 거래일 self-reset이라 점-청크에만 의존). detectSurgeSide로
 *  근접(95%)+히스테리시스(85%) 발사 지점을 산출 후 보이는 구간만 SurgeMarkerPoint로 투영(라인과 동일한
 *  axis.toVirtual/1000 좌표 + 그 시점 총잔량 값 price). 라벨 없는 점(circle)만 — 도달률(%) 텍스트는
 *  사용자 요청으로 미표시. 마감 동시호가는 항상 제외(그릴링 Q4). makePastCachedProjector가 과거/당일
 *  청크별로 호출·concat하므로 틱당 비용이 히스토리 깊이와 무관해진다(#56 P0).
 *  렌더는 SurgeMarkersPrimitive(timeToCoordinate 기반)가 맡아 series 길이 불일치에 면역. */
function surgeMarkerPoints(side: 'ask' | 'bid', color: string) {
  const maxField = side === 'ask' ? 'ask_max' : 'bid_max';
  return (points: readonly QuoteRatioPoint[], axis: VirtualAxis, ctx: QuoteTotalsCtx): SurgeMarkerPoint[] => {
    if (!ctx.surgeEnabled) return [];
    const startMinute = hhmmToMinute(ctx.surgeStartHHMM);
    const byT = ctx.intraMax ? new Map(points.map((p) => [p.t, p])) : null;
    return detectSurgeSide(points, side, {
      approachRatio: ctx.surgeApproachPct / 100,
      rearmRatio: ctx.surgeRearmPct / 100,
      isClosingAuction: (t) => axis.inClosingAuctionWindow(t),
    })
      // 표시 필터: 보이는 구간(axis.contains) + 시작 시각 이후(KST 분). 알고리즘 상태는
      // detectSurgeSide가 장 시작부터 전부 굴린 뒤, 발사된 마커만 여기서 가린다.
      .filter((m) => axis.contains(m.t) && kstMinuteOfDay(m.t) >= startMinute)
      .map((m) => {
        const pt = byT?.get(m.t);
        const price = ctx.intraMax && pt ? pt[maxField] : m.value;
        return {
          time: (axis.toVirtual(m.t) / 1000) as UTCTimestamp,
          price, // 그 시점 보이는 총잔량 라인 값 — priceToCoordinate 입력, aboveBar 배치
          color,
        };
      });
  };
}

const askSurgeCached = makePastCachedProjector(surgeMarkerPoints('ask', ask), (b) => b.quote_ratio.points);
const bidSurgeCached = makePastCachedProjector(surgeMarkerPoints('bid', bid), (b) => b.quote_ratio.points);
export const askSurgeMarkers = (b: RangeBundle, a: VirtualAxis, c: QuoteTotalsCtx) => askSurgeCached(b, a, c);
export const bidSurgeMarkers = (b: RangeBundle, a: VirtualAxis, c: QuoteTotalsCtx) => bidSurgeCached(b, a, c);

// crosshairMarkerBackgroundColor pins the hover marker to a solid series color
// so it survives the Auction Mask connector-break. maskOutgoingConnector
// transparents the last pre-auction point's per-point `color` to hide its
// outgoing segment into the auction window — but for a LineSeries that same
// per-point color also drives the crosshair marker (barColor), so the marker
// would vanish at that point (the 15:19 dot on 1m). Setting this series-level
// override decouples the marker from the per-point color (lightweight-charts
// resolves crosshairMarkerBackgroundColor before barColor), restoring the dot
// while keeping the line/fill hidden. BaselineSeries (RatioPane) already gets
// this for free because its marker color is series-level, not per-point — this
// makes 총잔량 consistent with 호가비.
// P0 과거/당일 분리 캐시 — 틱당 풀 재투영 제거. 출력은 projectBid/projectAsk와 동일.
const bidCachedRaw = makePastCachedProjector(
  (pts: readonly QuoteRatioPoint[], a: VirtualAxis, flags: number) =>
    projectBidPoints(pts, a, (flags & 1) !== 0, (flags & 2) !== 0),
  (b) => b.quote_ratio.points,
  { shouldPatchBoundary: isSyntheticHogaGapPoint, patchPastTail: LINE_HIDDEN_COLOR },
  quoteRatioPointsForSlice,
);
const askCachedRaw = makePastCachedProjector(
  (pts: readonly QuoteRatioPoint[], a: VirtualAxis, flags: number) =>
    projectAskPoints(pts, a, (flags & 1) !== 0, (flags & 2) !== 0),
  (b) => b.quote_ratio.points,
  { shouldPatchBoundary: isSyntheticHogaGapPoint, patchPastTail: LINE_HIDDEN_COLOR },
  quoteRatioPointsForSlice,
);
const flagsOf = (c: QuoteTotalsCtx): number => (c.auctionMask ? 1 : 0) | (c.intraMax ? 2 : 0);
const bidCachedData = (b: RangeBundle, a: VirtualAxis, c: QuoteTotalsCtx) => bidCachedRaw(b, a, flagsOf(c));
const askCachedData = (b: RangeBundle, a: VirtualAxis, c: QuoteTotalsCtx) => askCachedRaw(b, a, flagsOf(c));

export const QUOTE_TOTALS_SPEC = {
  name: 'quote-totals' as const,
  live: true, // reads quote_ratio (SSE-derived) → fed the live bundle on /live
  stretch: 0.4,
  useContext: useQuoteTotalsContext,
  series: [
    {
      type: LineSeries,
      options: {
        color: bid, lineWidth: 3, priceFormat, priceLineVisible: false,
        lastValueVisible: false, crosshairMarkerBackgroundColor: bid,
      },
      data: bidCachedData,
      markers: bidSurgeMarkers,
    },
    {
      type: LineSeries,
      options: {
        color: ask, lineWidth: 3, priceFormat, priceLineVisible: false,
        lastValueVisible: false, crosshairMarkerBackgroundColor: ask,
      },
      data: askCachedData,
      markers: askSurgeMarkers,
    },
  ],
} satisfies PaneSpec<QuoteTotalsCtx>;
