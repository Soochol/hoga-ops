/**
 * DataWindow — 워크스페이스 데이터 창의 실 콘텐츠 (ADR-0119 PR-C2c-1 → PR-D).
 *
 * 비차트 창(10호가·거래원·매물대·프로그램·잠정투자자)에 실제 사이드바 카드를
 * 렌더한다. 각 창은 그룹→종목의 code 로 자기 데이터를 구독한다.
 *
 * 데이터 흐름 (PR-D 크로스헤어 버스·그룹 차트 링크):
 * - **LATEST 모드**: `live`(WS 스냅샷 버퍼) + per-code 쿼리 — 레거시 LiveSidebar 의
 *   latest 경로와 동일.
 * - **스팟 모드**: 같은 링크 그룹 차트 창의 분봉 호버가 sidebarCursorMs 를 origin
 *   (창·그룹·봉) 태그와 함께 발행하면(useLiveCursorStore), 그룹이 일치하는 데이터
 *   창만 파케이 스팟 훅(useLiveOrderbookAtCursor·useLiveBrokersAtCursor)으로 전환
 *   한다 — 장 마감 중에도 과거 캔들 호버로 호가·거래원을 볼 수 있다.
 * - **매물대·프로그램**: 번들(timeframe 종속)이 필요해 그룹의 대상 차트 창이
 *   발행하는 그룹 차트 링크(groupChartLinkSource — bundle·timeframe·todayKst·매물대
 *   설정)를 소비한다. 같은 그룹에 차트 창이 없으면 연동 대기 카드.
 *
 * kind 별로 필요한 훅이 다르므로 하위 컴포넌트로 분기한다(한 컴포넌트에서 조건부
 * 훅 호출 금지 — 각 하위 컴포넌트가 자기 훅만 무조건 호출).
 */
import { useMemo } from 'react';
import OrderbookTable from '../../sidebar/OrderbookTable';
import TotalQtyBar from '../../sidebar/TotalQtyBar';
import BrokerTrajectoryTable from '../../sidebar/BrokerTrajectoryTable';
import ProgramTradeSummaryCard from '../../sidebar/ProgramTradeSummaryCard';
import { VolumeDistributionCard } from '../../sidebar/VolumeDistributionCard';
import { InvestorTrendEstimateCard } from '../../sidebar/InvestorTrendEstimateCard';
import {
  resolveBrokerCardProps,
  resolveCursorDetailScope,
  resolveOrderbookCardSnapshot,
} from '../../sidebar/cursorDetailResolver';
import { useLiveSeries } from '../../api/liveSeries';
import { useLiveInvestorTrendEstimate } from '../../api/liveInvestorTrendEstimate';
import { useQuoteByCode } from '../../api/liveQuotes';
import {
  useLiveOrderbookAtCursor,
  useLiveBrokersAtCursor,
} from '../../api/useLiveCursor';
import { useLiveVenueStore } from '../../state/liveVenue';
import { useChartPrefsStore } from '../../state/chartPrefs';
import { isMinuteTimeframe, type LiveTimeframe } from '../../state/livePage';
import { TIMEFRAME_TO_MS, type RangeSegment, type Timeframe } from '../../api/types';
import { isClosingAuction, type SessionSegment } from '../../util/sessionTime';
import {
  aggregateBrokerSeries,
  latestOrderbookSnapshot,
  orderbookSnapshotAtCursor,
} from '../liveSidebarAdapters';
import { useLiveCursorStore } from '../useLiveCursorStore';
import { useGroupChartLink } from './groupChartLinkSource';
import {
  useLiveDistributionTrades,
  useLiveTodayVolumeDistribution,
} from '../useLiveVolumeDistribution';
import { useVolumeDistributionCutoffProfile } from '../useVolumeDistributionCutoffProfile';
import {
  buildCandleDateIndex,
  firstTrailingSinglePriceBookMs,
  volumeDistributionClosePointsFromCandles,
} from '../continuousTradeVolumeDistribution';
import { realMsToYyyymmdd } from '../liveDateTime';
import { SectorRankingWindow } from './SectorRankingWindow';
import { isLiveIndexId } from '../liveInstrument';
import type { GroupId, GroupSymbol, WorkspaceWindow, WindowKind } from '../../state/workspace';

const KIND_LABEL: Record<WindowKind, string> = {
  chart: '차트',
  book: '10호가',
  broker: '거래원',
  vdist: '매물대',
  program: '프로그램',
  investor: '잠정투자자',
  'sector-ranking': '섹터 랭킹',
};

export function DataWindow({ win, symbol }: { win: WorkspaceWindow; symbol: GroupSymbol | null }) {
  // 섹터 랭킹은 지수 그룹 전용 데이터 창(PR-D) — 일반 지수 게이트보다 먼저 처리한다
  // (지수에서 유일하게 허용되는 kind). 주식·미지정 그룹에는 안내 카드.
  if (win.kind === 'sector-ranking') {
    if (symbol?.kind === 'index' && isLiveIndexId(symbol.code)) {
      return <SectorRankingWindow indexId={symbol.code} />;
    }
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg-subtle/40 text-center text-[11px] text-fg-dimmer">
        <span className="font-mono">
          {KIND_LABEL[win.kind]} · 지수 그룹 전용
          <br />
          {symbol ? `${symbol.name} 은 지수가 아닙니다` : `종목 없음 (그룹 ${win.group})`}
        </span>
      </div>
    );
  }
  // 지수는 호가/거래원/투자자 데이터가 없다 — 구독 오염 대신 안내 카드(C2c-2c).
  if (symbol?.kind === 'index') {
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg-subtle/40 text-center text-[11px] text-fg-dimmer">
        <span className="font-mono">
          {KIND_LABEL[win.kind]} · {symbol.name}
          <br />
          지수는 지원하지 않습니다
        </span>
      </div>
    );
  }
  const code = symbol?.code ?? null;
  if (!code) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg-subtle/40 text-[11px] text-fg-dimmer">
        <span className="font-mono">
          {KIND_LABEL[win.kind]} · 종목 없음 (그룹 {win.group})
        </span>
      </div>
    );
  }
  switch (win.kind) {
    case 'book':
      return <BookWindow win={win} code={code} />;
    case 'broker':
      return <BrokerWindow win={win} code={code} />;
    case 'investor':
      return <InvestorWindow code={code} />;
    case 'vdist':
      return <VdistWindow win={win} code={code} />;
    case 'program':
      return <ProgramWindow win={win} code={code} />;
    default:
      // 'chart'·'sector-ranking' 은 이 지점에 오지 않는다(위·WorkspaceCanvas 분기).
      return null;
  }
}

/**
 * 그룹 게이트된 스팟 커서 — 같은 링크 그룹 차트 창의 호버만 통과시킨다
 * (ADR-0119 PR-D 크로스헤어 버스). 다른 그룹 차트를 호버 중이면 latest 유지.
 */
function useGroupCursor(group: GroupId): { cursorMs: number | null; timeframe: LiveTimeframe | null } {
  const cursorMs = useLiveCursorStore((s) => s.sidebarCursorMs);
  const origin = useLiveCursorStore((s) => s.sidebarCursorOrigin);
  if (cursorMs === null || origin === null || origin.group !== group) {
    return { cursorMs: null, timeframe: null };
  }
  return { cursorMs, timeframe: origin.timeframe };
}

/** 매물대·프로그램의 연동 대기 카드 — 같은 그룹에 차트 창이 없을 때. */
function LinkPendingCard({ kind, group }: { kind: WindowKind; group: GroupId }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-bg-subtle/40 text-center text-[11px] text-fg-dimmer">
      <span className="font-mono">
        {KIND_LABEL[kind]} · 차트 창 연동 대기
        <br />
        그룹 {group}에 차트 창을 추가하면 표시됩니다
      </span>
    </div>
  );
}

function BookWindow({ win, code }: { win: WorkspaceWindow; code: string }) {
  const live = useLiveSeries(code);
  const venue = useLiveVenueStore((s) => s.venue);
  const { cursorMs, timeframe: cursorTimeframe } = useGroupCursor(win.group);
  const link = useGroupChartLink(win.group);
  // 스팟 진입은 분봉 호버만(ADR-0044) — D/W/M 호버는 latest 유지.
  const scope = resolveCursorDetailScope({ cursorMs, timeframe: cursorTimeframe });
  const isSpot = scope.kind === 'minute-cursor';
  const spotTimeframe = isSpot ? scope.minuteTimeframe : null;
  const spotOrderbook = useLiveOrderbookAtCursor({
    code: isSpot ? code : null,
    timeframe: spotTimeframe,
  });
  const latestSnapshot = useMemo(() => latestOrderbookSnapshot(live.ob), [live.ob]);
  const spotSnap = spotOrderbook === undefined ? undefined : spotOrderbook.snapshot;
  // 파케이 스팟이 비었을 때 WS 버퍼로 그 버킷의 실제 호가를 복원(ADR-0044 개정 —
  // 승격 지연 ~2-5분 커버). 레거시 LiveSidebar 폴백과 동일 조성.
  const bufferSnap = useMemo(
    () =>
      isSpot && spotSnap === null && spotTimeframe !== null && scope.cursorMs !== null
        ? orderbookSnapshotAtCursor(live.ob, scope.cursorMs, TIMEFRAME_TO_MS[spotTimeframe as Timeframe])
        : null,
    [isSpot, spotSnap, spotTimeframe, scope.cursorMs, live.ob],
  );
  const snapshot = resolveOrderbookCardSnapshot({
    scope,
    spotSnapshot: spotSnap,
    inactiveSnapshot: latestSnapshot,
    bufferFallbackSnapshot: bufferSnap,
  });
  const quote = useQuoteByCode([code], venue).get(code);
  const baselinePrice = quote?.baseline_price ?? null;
  // 동시호가 마스크(PR-D2): 스팟 커서가 종가 동시호가 구간(마감 10분)에 있고 전역
  // auctionWindowMask 토글이 켜져 있으면 매수/매도 비율을 마스킹한다. 판정은 링크
  // 차트 창 번들의 세션 세그먼트로 — 전역 axis store 는 멀티창 last-writer-wins 라
  // 부정확. 링크 부재/비스팟이면 마스크 없음(latest 는 레거시도 비활성).
  const auctionWindowMask = useChartPrefsStore((s) => s.auctionWindowMask);
  const maskRatio = !!(
    auctionWindowMask &&
    isSpot &&
    scope.cursorMs !== null &&
    link !== null &&
    link.bundle !== null &&
    isClosingAuction(toSessionSegments(link.bundle.segments), scope.cursorMs)
  );
  // T14b: 스팟 슬롯이 비었고 버퍼도 못 채우는 진짜 공백이면 "다음 가용" 힌트.
  const availableFrom = spotOrderbook?.available_from ?? null;
  const showAvailableHint =
    isSpot && spotOrderbook !== undefined && spotSnap === null && bufferSnap === null && availableFrom !== null;
  return (
    <div className="h-full overflow-auto">
      {showAvailableHint && (
        <div
          data-testid="orderbook-available-hint"
          className="px-3 py-1 font-mono text-[11px] text-fg-dimmer"
        >
          다음 가용: {formatKstClock(availableFrom)}
        </div>
      )}
      <OrderbookTable snapshot={snapshot} baselinePrice={baselinePrice} />
      <TotalQtyBar snapshot={snapshot} maskRatio={maskRatio} />
    </div>
  );
}

function BrokerWindow({ win, code }: { win: WorkspaceWindow; code: string }) {
  const live = useLiveSeries(code);
  const { cursorMs, timeframe: cursorTimeframe } = useGroupCursor(win.group);
  const scope = resolveCursorDetailScope({ cursorMs, timeframe: cursorTimeframe });
  const spotSeries = useLiveBrokersAtCursor({
    code: scope.kind === 'minute-cursor' ? code : null,
    timeframe: scope.minuteTimeframe,
  });
  const latestSeries = useMemo(() => aggregateBrokerSeries(live.broker), [live.broker]);
  // 비었을 때 fallback 은 null — 시리즈도 비어 표시가 동일하므로 Date.now()(impure) 불필요.
  const latestTs = live.broker.length > 0 ? (live.broker[live.broker.length - 1].t_ms as number) : null;
  // latest 모드는 항상 배열을 넘긴다(빈 배열 → "거래원 정보 없음"). 레거시의
  // undefined 폴백은 로딩 상태("커서 위치 로딩 중…")로 표기돼 빈 버퍼가 영구
  // 로딩처럼 보이는 함정 — 데이터 창에서는 빈 상태가 맞다.
  const card = resolveBrokerCardProps({
    scope,
    spotSeries,
    inactiveSeries: latestSeries,
    inactiveCursorMs: latestTs,
  });
  return (
    <div className="h-full overflow-auto">
      <BrokerTrajectoryTable series={card.series} cursorMs={card.cursorMs} />
    </div>
  );
}

function InvestorWindow({ code }: { code: string }) {
  const query = useLiveInvestorTrendEstimate(code);
  return (
    <div className="h-full overflow-auto">
      <InvestorTrendEstimateCard query={query} />
    </div>
  );
}

/** 링크 부재 시 매물대 설정 폴백(공장 기본과 동일 값) — 연동 대기 카드가 뜨는
 *  동안 비활성 훅에만 공급되므로 표시에는 쓰이지 않는다. */
const VDIST_FALLBACK = { rangeCount: 10, color: '#64748B', maxColor: '#EAB308', hoverCutoffEnabled: false };

function VdistWindow({ win, code }: { win: WorkspaceWindow; code: string }) {
  const live = useLiveSeries(code);
  const link = useGroupChartLink(win.group);
  // 링크의 code 가 창의 code 와 다르면(그룹 종목 교체 직후 발행 지연 프레임) 소비하지
  // 않는다 — 이전 종목 번들이 새 종목 창에 새는 것을 막는 가드.
  const linked = link !== null && link.code === code;
  const bundle = linked ? link.bundle : null;
  const timeframe = linked ? link.timeframe : null;
  const todayKst = linked ? link.todayKst : '';
  const vdistSettings = linked ? link.vdist : VDIST_FALLBACK;
  const { cursorMs, timeframe: cursorTimeframe } = useGroupCursor(win.group);
  const scope = resolveCursorDetailScope({ cursorMs, timeframe: cursorTimeframe });
  const isSpot = scope.kind === 'minute-cursor';
  const spotCursorMs = isSpot ? scope.cursorMs : null;
  const spotTimeframe = isSpot ? scope.minuteTimeframe : null;

  // ── 이하 조성은 레거시 LiveSidebar 의 매물대 경로 이식(#719 플립으로 삭제된
  //    LiveSidebar.tsx — 활성 날짜 선정·오늘 증분 fold·호버 컷오프·종가 라인). ──
  const activeDate = spotCursorMs !== null
    ? realMsToYyyymmdd(spotCursorMs)
    : (bundle?.segments[bundle.segments.length - 1]?.date ?? todayKst ?? null);
  const candleDateIndex = useMemo(
    () => buildCandleDateIndex(bundle?.candles ?? []),
    [bundle?.candles],
  );
  const activeCandles = useMemo(() => {
    if (!bundle || !activeDate) return [];
    return candleDateIndex.get(activeDate) ?? [];
  }, [bundle, activeDate, candleDateIndex]);
  const persistedDistributions = useMemo(
    () => bundle?.volume_distributions ?? [],
    [bundle?.volume_distributions],
  );
  const liveDistribution = useLiveDistributionTrades(live.trade, linked);
  const todayContinuousBeforeMs = useMemo(() => {
    if (!bundle || !todayKst) return null;
    const todaySegment = bundle.segments.find((segment) => segment.date === todayKst);
    if (!todaySegment) return null;
    return firstTrailingSinglePriceBookMs(live.ob, todaySegment.session_close_ms);
  }, [bundle, todayKst, live.ob]);
  const todaySegment = useMemo(
    () => bundle?.segments.find((segment) => segment.date === todayKst) ?? null,
    [bundle, todayKst],
  );
  const persistedToday = useMemo(
    () => (todayKst
      ? persistedDistributions.find((profile) => profile.date === todayKst) ?? null
      : null),
    [persistedDistributions, todayKst],
  );
  const todayProfile = useLiveTodayVolumeDistribution({
    enabled: linked && !!bundle,
    stockCode: code,
    todayKst: todayKst || null,
    isMinute: timeframe !== null && isMinuteTimeframe(timeframe),
    rangeCount: vdistSettings.rangeCount,
    todayCandles: (todayKst ? candleDateIndex.get(todayKst) : undefined) ?? [],
    todaySegment,
    persistedToday,
    liveTrades: liveDistribution,
    continuousBeforeMs: todayContinuousBeforeMs,
  });
  const activeProfile = useMemo(() => {
    if (activeDate && activeDate === todayKst) return todayProfile;
    return persistedDistributions.find((profile) => profile.date === activeDate) ?? null;
  }, [activeDate, todayKst, todayProfile, persistedDistributions]);
  const priceRange = useMemo(() => {
    if (
      activeProfile
      && Number.isFinite(activeProfile.price_min)
      && Number.isFinite(activeProfile.price_max)
      && activeProfile.price_min < activeProfile.price_max
    ) {
      return { min: activeProfile.price_min, max: activeProfile.price_max };
    }
    return candleRangeUnbounded(activeCandles);
  }, [activeProfile, activeCandles]);
  const cutoffProfile = useVolumeDistributionCutoffProfile({
    enabled: linked && vdistSettings.hoverCutoffEnabled && isSpot,
    code,
    timeframe: spotTimeframe,
    date: activeDate,
    cursorMs: spotCursorMs,
    todayKst: todayKst || null,
    rangeCount: vdistSettings.rangeCount,
    finalProfile: activeProfile,
    priceRange,
    liveTrades: liveDistribution.trades,
    candles: activeCandles,
    segment: bundle?.segments.find((segment) => segment.date === activeDate) ?? null,
  });
  const closePoints = useMemo(
    () => (activeDate ? volumeDistributionClosePointsFromCandles(activeCandles) : []),
    [activeCandles, activeDate],
  );
  // 마커: 스팟=호버 시각, latest=마지막 체결 시각(장중 "지금" 위치 표시. 없으면 숨김).
  const markerCursorMs = isSpot
    ? spotCursorMs
    : (live.trade.length > 0 ? live.trade[live.trade.length - 1].t_ms : null);

  if (!linked) return <LinkPendingCard kind={win.kind} group={win.group} />;
  return (
    <div className="h-full overflow-auto">
      <VolumeDistributionCard
        profile={cutoffProfile}
        cursorMs={markerCursorMs}
        closePoints={closePoints}
        color={vdistSettings.color}
        maxColor={vdistSettings.maxColor}
      />
    </div>
  );
}

function ProgramWindow({ win, code }: { win: WorkspaceWindow; code: string }) {
  const link = useGroupChartLink(win.group);
  const { cursorMs, timeframe: cursorTimeframe } = useGroupCursor(win.group);
  const scope = resolveCursorDetailScope({ cursorMs, timeframe: cursorTimeframe });
  const linked = link !== null && link.code === code;
  if (!linked) return <LinkPendingCard kind={win.kind} group={win.group} />;
  return (
    <div className="h-full overflow-auto">
      <ProgramTradeSummaryCard
        series={link.bundle?.program_trade ?? null}
        cursorMs={scope.kind === 'minute-cursor' ? scope.cursorMs : null}
      />
    </div>
  );
}

// 번들 세그먼트(snake_case) → sessionTime.isClosingAuction 입력형(camelCase).
// VolumeDistributionCard 의 동일 사상과 같은 어댑터 — 도메인 판정은 단일 소스
// (sessionTime)를 재사용해 axis 와 동치 유지(virtualAxis.inClosingAuctionWindow 위임 대상).
function toSessionSegments(segments: readonly RangeSegment[]): SessionSegment[] {
  return segments.map((s) => ({ sessionOpenMs: s.session_open_ms, sessionCloseMs: s.session_close_ms }));
}

// KST 표기 — 사이드바 카드들(OrderbookTable 등)과 동일하게 toLocaleTimeString.
// 로컬 tz 시계는 비-KST 워크스테이션에서 차트 x축과 어긋난다.
function formatKstClock(tsMs: number): string {
  return new Date(tsMs).toLocaleTimeString('ko-KR', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

// 세션 경계 없이 캔들 low/high 만으로 가격 범위 산출(매물대 가격축 폴백). 이름을
// useLiveBundle 의 candlePriceRange(세션 경계 3-arg)와 구분 — 같은 이름·다른 arity
// 혼동 방지(리뷰 지적).
function candleRangeUnbounded(
  candles: readonly { low: number; high: number }[],
): { min: number; max: number } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const candle of candles) {
    if (Number.isFinite(candle.low)) min = Math.min(min, candle.low);
    if (Number.isFinite(candle.high)) max = Math.max(max, candle.high);
  }
  return Number.isFinite(min) && Number.isFinite(max) && min < max ? { min, max } : null;
}
