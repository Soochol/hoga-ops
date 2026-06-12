import {
  LineSeries,
  type LineData,
  type UTCTimestamp,
  type Time,
  type SeriesMarker,
} from 'lightweight-charts';
import { useShallow } from 'zustand/react/shallow';
import type { RangeBundle, QuoteRatioPoint } from '../../api/types';
import { type VirtualAxis } from '../../util/virtualAxis';
import { resolveTokens } from '../../util/tokens';
import { useActivePrefs } from '../../state/chartPrefs';
import type { PaneSpec } from '../RangeSeriesPane';
import { isAuctionHidden, LINE_HIDDEN_COLOR, maskOutgoingConnector } from '../util/auctionHide';
import { makePastCachedProjector } from './pastCachedProjector';
import { detectSurges } from '../surge/detectSurges';

const TOKEN_SPEC = {
  bid: ['--price-up', '#DC2626'],   // 매수 호가 총합 (KRX 빨강)
  ask: ['--price-down', '#2563EB'], // 매도 호가 총합 (KRX 파랑)
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
  return projectBidPoints(bundle.quote_ratio.points, axis, auctionWindowMask);
}

/** Points-array variant of {@link projectBid} — see projectRatioPoints /
 * makePastCachedProjector for the /live past-cache rationale and the day-boundary
 * equivalence invariant. */
export function projectBidPoints(
  points: readonly QuoteRatioPoint[],
  axis: VirtualAxis,
  auctionWindowMask: boolean,
): LineData<Time>[] {
  const out: LineData<Time>[] = [];
  for (const p of points) {
    if (!axis.contains(p.t)) continue;
    const time = (axis.toVirtual(p.t) / 1000) as UTCTimestamp;
    // Auction-window hide (ADR-0029, util/auctionHide.ts). Break the connector
    // from the last pre-auction point so the line doesn't slope into the window.
    if (isAuctionHidden(axis, auctionWindowMask, p.t)) {
      maskOutgoingConnector(out, LINE_HIDDEN_COLOR);
      out.push({ time, value: 0, ...LINE_HIDDEN_COLOR });
      continue;
    }
    out.push({ time, value: p.bid_total });
  }
  return out;
}

export function projectAsk(
  bundle: RangeBundle,
  axis: VirtualAxis,
  auctionWindowMask: boolean,
): LineData<Time>[] {
  return projectAskPoints(bundle.quote_ratio.points, axis, auctionWindowMask);
}

/** Points-array variant of {@link projectAsk}. */
export function projectAskPoints(
  points: readonly QuoteRatioPoint[],
  axis: VirtualAxis,
  auctionWindowMask: boolean,
): LineData<Time>[] {
  const out: LineData<Time>[] = [];
  for (const p of points) {
    if (!axis.contains(p.t)) continue;
    const time = (axis.toVirtual(p.t) / 1000) as UTCTimestamp;
    if (isAuctionHidden(axis, auctionWindowMask, p.t)) {
      maskOutgoingConnector(out, LINE_HIDDEN_COLOR);
      out.push({ time, value: 0, ...LINE_HIDDEN_COLOR });
      continue;
    }
    out.push({ time, value: p.ask_total });
  }
  return out;
}

export type QuoteTotalsCtx = { auctionMask: boolean; surgeEnabled: boolean; surgeMarginPct: number };

// useShallow: object literal reference stays stable when the three fields don't
// change → makePastCachedProjector's ctx-identity cache key (via bidCachedData's
// ctx.auctionMask) and React.memo both hold. Same pattern as ratio.ts / fillStrength.ts.
const useQuoteTotalsContext = (): QuoteTotalsCtx =>
  useActivePrefs(
    useShallow((p) => ({
      auctionMask: p.auctionWindowMask,
      surgeEnabled: p.surgeMarkerEnabled,
      surgeMarginPct: p.surgeMarginPct,
    })),
  );

/** 한 side의 급증 마커. detectSurges(전 구간 단일패스)로 산출 후 보이는 구간만 SeriesMarker로 투영
 *  (라인과 동일한 axis.toVirtual/1000 시간좌표). 마감 동시호가는 항상 제외(그릴링 Q4). */
function surgeMarkersFor(
  side: 'ask' | 'bid',
  bundle: RangeBundle,
  axis: VirtualAxis,
  ctx: QuoteTotalsCtx,
): SeriesMarker<Time>[] {
  if (!ctx.surgeEnabled) return [];
  const result = detectSurges(bundle.quote_ratio.points, {
    margin: ctx.surgeMarginPct / 100,
    sessionOpens: bundle.segments.map((s) => s.session_open_ms),
    isClosingAuction: (t) => axis.inClosingAuctionWindow(t),
  });
  const color = side === 'ask' ? ask : bid;
  return result[side]
    .filter((m) => axis.contains(m.t))
    .map((m) => ({
      time: (axis.toVirtual(m.t) / 1000) as UTCTimestamp,
      position: 'aboveBar' as const,
      shape: 'circle' as const,
      color,
      text: `+${Math.round(m.pctOver * 100)}%`,
    }));
}

export const askSurgeMarkers = (b: RangeBundle, a: VirtualAxis, c: QuoteTotalsCtx) =>
  surgeMarkersFor('ask', b, a, c);
export const bidSurgeMarkers = (b: RangeBundle, a: VirtualAxis, c: QuoteTotalsCtx) =>
  surgeMarkersFor('bid', b, a, c);

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
const bidCachedRaw = makePastCachedProjector(projectBidPoints, (b) => b.quote_ratio.points);
const askCachedRaw = makePastCachedProjector(projectAskPoints, (b) => b.quote_ratio.points);
// ctx 객체에서 auctionMask(값-안정 boolean)만 내부 캐시에 전달 → Split Cache 캐시키 안정 유지.
const bidCachedData = (b: RangeBundle, a: VirtualAxis, c: QuoteTotalsCtx) => bidCachedRaw(b, a, c.auctionMask);
const askCachedData = (b: RangeBundle, a: VirtualAxis, c: QuoteTotalsCtx) => askCachedRaw(b, a, c.auctionMask);

export const QUOTE_TOTALS_SPEC = {
  name: 'quote-totals' as const,
  live: true, // reads quote_ratio (SSE-derived) → fed the live bundle on /live
  stretch: 0.4,
  useContext: useQuoteTotalsContext,
  series: [
    {
      type: LineSeries,
      options: {
        color: bid, lineWidth: 1, priceFormat, priceLineVisible: false,
        lastValueVisible: false, crosshairMarkerBackgroundColor: bid,
      },
      data: bidCachedData,
      markers: bidSurgeMarkers,
    },
    {
      type: LineSeries,
      options: {
        color: ask, lineWidth: 1, priceFormat, priceLineVisible: false,
        lastValueVisible: false, crosshairMarkerBackgroundColor: ask,
      },
      data: askCachedData,
      markers: askSurgeMarkers,
    },
  ],
} satisfies PaneSpec<QuoteTotalsCtx>;
