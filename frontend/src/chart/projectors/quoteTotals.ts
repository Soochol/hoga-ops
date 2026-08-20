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
import { resolveTokensThemed, currentThemeKey } from '../../util/tokens';
import { useActivePrefs } from '../../state/chartPrefs';
import type { PaneSpec } from '../RangeSeriesPane';
import type { SurgeMarkerPoint } from '../SurgeMarkersPrimitive';
import { isExcludedQuoteBucket, LINE_HIDDEN_COLOR, maskOutgoingConnector } from '../util/auctionHide';
import { makePastCachedProjector } from './pastCachedProjector';
import { quoteRatioPointsForBundle, quoteRatioPointsForSlice } from './quoteRatioPoints';
import { detectSurgeSide } from '../surge/detectSurges';

const TOKEN_SPEC = {
  bid: ['--price-up', '#F04452'],   // 매수 호가 총합 (KRX 빨강)
  ask: ['--price-down', '#3485FA'], // 매도 호가 총합 (KRX 파랑)
} as const;

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
  const { bid } = resolveTokensThemed(TOKEN_SPEC);
  const out: LineData<Time>[] = [];
  // 축 조회 1회 — `classifyAndProject` 가 `contains`·`inClosingAuctionWindow`·`toVirtual`
  // 을 한 번의 이진 탐색으로 준다. 근거·실측은 `chart/util/auctionHide.ts` 의
  // `isAuctionHidden` 경고 참조. 계약은 `candle.perf.test.ts` 가 호출 횟수로 잠근다.
  for (const p of points) {
    const at = axis.classifyAndProject(p.t);
    if (!at.contained) continue;
    const time = (at.virtual / 1000) as UTCTimestamp;
    if (isSyntheticHogaGapPoint(p)) {
      maskOutgoingConnector(out, LINE_HIDDEN_COLOR);
      out.push({ time, value: 0, ...LINE_HIDDEN_COLOR });
      continue;
    }
    // Auction-window hide (ADR-0029, util/auctionHide.ts). Break the connector
    // from the last pre-auction point so the line doesn't slope into the window.
    // 시간 마스크(마감 동시호가) OR 구조 센티넬(장중 VI 포함, (0,0)) — ADR-0062 v2.
    if (
      (auctionWindowMask && at.inAuction) ||
      isExcludedQuoteBucket(auctionWindowMask, p.bid_total, p.ask_total)
    ) {
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
  const { ask } = resolveTokensThemed(TOKEN_SPEC);
  const out: LineData<Time>[] = [];
  // 축 조회 1회 — `classifyAndProject` 가 `contains`·`inClosingAuctionWindow`·`toVirtual`
  // 을 한 번의 이진 탐색으로 준다. 근거·실측은 `chart/util/auctionHide.ts` 의
  // `isAuctionHidden` 경고 참조. 계약은 `candle.perf.test.ts` 가 호출 횟수로 잠근다.
  for (const p of points) {
    const at = axis.classifyAndProject(p.t);
    if (!at.contained) continue;
    const time = (at.virtual / 1000) as UTCTimestamp;
    if (isSyntheticHogaGapPoint(p)) {
      maskOutgoingConnector(out, LINE_HIDDEN_COLOR);
      out.push({ time, value: 0, ...LINE_HIDDEN_COLOR });
      continue;
    }
    // 시간 마스크(마감 동시호가) OR 구조 센티넬(장중 VI 포함, (0,0)) — ADR-0062 v2.
    if (
      (auctionWindowMask && at.inAuction) ||
      isExcludedQuoteBucket(auctionWindowMask, p.bid_total, p.ask_total)
    ) {
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
  /** 호가단위 변화 보정(기본 off). 켜면 급증 검출이 사다리 폭 변화만큼 running peak 을
   *  환산한다 — detectSurgeSide 의 widthStepRatio 주석에 근거·실측이 있다. */
  tickNormalize: boolean;
  /** 위 보정의 **확인 게이트** 문턱(%) — 호가단위가 바뀐 시점에 사다리 폭이 이만큼은
   *  실제로 움직여야 환산한다. 보정이 꺼져 있으면 쓰이지 않는다. */
  surgeTickConfirmPct: number;
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
      tickNormalize: p.quoteTotalsTickNormalize,
      surgeTickConfirmPct: p.surgeTickConfirmPct,
    })),
  );

/** 한 side의 급증 마커 프로젝터(per-side, 거래일 self-reset이라 점-청크에만 의존). detectSurgeSide로
 *  근접(95%)+히스테리시스(85%) 발사 지점을 산출 후 보이는 구간만 SurgeMarkerPoint로 투영(라인과 동일한
 *  axis.toVirtual/1000 좌표 + 그 시점 총잔량 값 price). 라벨 없는 점(circle)만 — 도달률(%) 텍스트는
 *  사용자 요청으로 미표시. 마감 동시호가는 항상 제외(그릴링 Q4). makePastCachedProjector가 과거/당일
 *  청크별로 호출·concat하므로 틱당 비용이 히스토리 깊이와 무관해진다(#56 P0).
 *  렌더는 SurgeMarkersPrimitive(timeToCoordinate 기반)가 맡아 series 길이 불일치에 면역. */
function surgeMarkerPoints(side: 'ask' | 'bid') {
  const maxField = side === 'ask' ? 'ask_max' : 'bid_max';
  return (points: readonly QuoteRatioPoint[], axis: VirtualAxis, ctx: QuoteTotalsCtx): SurgeMarkerPoint[] => {
    if (!ctx.surgeEnabled) return [];
    // Resolve per call so surge dots follow the live theme (via the chart
    // remount on a theme swap). bid=매수=빨강, ask=매도=파랑.
    const t = resolveTokensThemed(TOKEN_SPEC);
    const color = side === 'ask' ? t.ask : t.bid;
    const startMinute = hhmmToMinute(ctx.surgeStartHHMM);
    const byT = ctx.intraMax ? new Map(points.map((p) => [p.t, p])) : null;
    return detectSurgeSide(points, side, {
      approachRatio: ctx.surgeApproachPct / 100,
      rearmRatio: ctx.surgeRearmPct / 100,
      isClosingAuction: (t) => axis.inClosingAuctionWindow(t),
      // 꺼져 있으면 **undefined 를 넘긴다** — 0 을 넘기면 확인 게이트가 항상 통과라
      // ETF 처럼 표가 틀리는 종목군에서 헛환산이 난다.
      tickConfirmRatio: ctx.tickNormalize ? ctx.surgeTickConfirmPct / 100 : undefined,
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

const askSurgeCached = makePastCachedProjector(surgeMarkerPoints('ask'), (b) => b.quote_ratio.points);
const bidSurgeCached = makePastCachedProjector(surgeMarkerPoints('bid'), (b) => b.quote_ratio.points);
/** 급증 마커 OFF 일 때 돌려주는 **공유** 빈 배열. `SurgeMarkersPrimitive.setMarkers` 는
 *  참조를 보관만 하고 변형하지 않으므로 안전하고, 매 틱 새 `[]` 를 만들지 않는다. */
const NO_SURGE_MARKERS: SurgeMarkerPoint[] = [];
// 토글 게이트를 **캐시 래퍼 바깥**에 둔다. `surgeMarkerPoints` 안의 조기 반환만으로는
// 래퍼가 이미 slice·expand 를 지불한 뒤라, 꺼 놔도 틱당 비용이 0 이 아니었다
// (90일 실측 0.158ms/틱, 양쪽 합). 안쪽 가드는 직접 호출자를 위해 남겨 둔다.
export const askSurgeMarkers = (b: RangeBundle, a: VirtualAxis, c: QuoteTotalsCtx) =>
  (c.surgeEnabled ? askSurgeCached(b, a, c) : NO_SURGE_MARKERS);
export const bidSurgeMarkers = (b: RangeBundle, a: VirtualAxis, c: QuoteTotalsCtx) =>
  (c.surgeEnabled ? bidSurgeCached(b, a, c) : NO_SURGE_MARKERS);

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
// Cache key = `${flags}|${theme}`. Per-point `color: bid/ask` is embedded in
// the cached past data, so the theme segment forces a re-projection on a theme
// swap even if the same axis survives (defense-in-depth beyond the remount).
// parseInt reads the numeric flags prefix and stops at the '|'.
const bidCachedRaw = makePastCachedProjector(
  (pts: readonly QuoteRatioPoint[], a: VirtualAxis, key: string) => {
    const flags = parseInt(key, 10);
    return projectBidPoints(pts, a, (flags & 1) !== 0, (flags & 2) !== 0);
  },
  (b) => b.quote_ratio.points,
  { shouldPatchBoundary: isSyntheticHogaGapPoint, patchPastTail: LINE_HIDDEN_COLOR },
  quoteRatioPointsForSlice,
);
const askCachedRaw = makePastCachedProjector(
  (pts: readonly QuoteRatioPoint[], a: VirtualAxis, key: string) => {
    const flags = parseInt(key, 10);
    return projectAskPoints(pts, a, (flags & 1) !== 0, (flags & 2) !== 0);
  },
  (b) => b.quote_ratio.points,
  { shouldPatchBoundary: isSyntheticHogaGapPoint, patchPastTail: LINE_HIDDEN_COLOR },
  quoteRatioPointsForSlice,
);
const keyOf = (c: QuoteTotalsCtx): string =>
  `${(c.auctionMask ? 1 : 0) | (c.intraMax ? 2 : 0)}|${currentThemeKey()}`;
const bidCachedData = (b: RangeBundle, a: VirtualAxis, c: QuoteTotalsCtx) => bidCachedRaw(b, a, keyOf(c));
const askCachedData = (b: RangeBundle, a: VirtualAxis, c: QuoteTotalsCtx) => askCachedRaw(b, a, keyOf(c));

export const QUOTE_TOTALS_SPEC = {
  name: 'quote-totals' as const,
  bundleKind: 'hoga', // quote_ratio(todaySource='bundle')를 읽는다
  stretch: 0.4,
  legendToggleKey: 'quoteTotalsEnabled',
  legendTitle: '총잔량',
  useContext: useQuoteTotalsContext,
  series: [
    {
      type: LineSeries,
      options: () => {
        const { bid } = resolveTokensThemed(TOKEN_SPEC);
        return {
          color: bid, lineWidth: 3, priceFormat, priceLineVisible: false,
          lastValueVisible: false, crosshairMarkerBackgroundColor: bid,
        };
      },
      data: bidCachedData,
      markers: bidSurgeMarkers,
      legend: { label: '매수', color: () => resolveTokensThemed(TOKEN_SPEC).bid },
    },
    {
      type: LineSeries,
      options: () => {
        const { ask } = resolveTokensThemed(TOKEN_SPEC);
        return {
          color: ask, lineWidth: 3, priceFormat, priceLineVisible: false,
          lastValueVisible: false, crosshairMarkerBackgroundColor: ask,
        };
      },
      data: askCachedData,
      markers: askSurgeMarkers,
      legend: { label: '매도', color: () => resolveTokensThemed(TOKEN_SPEC).ask },
    },
  ],
} satisfies PaneSpec<QuoteTotalsCtx>;
