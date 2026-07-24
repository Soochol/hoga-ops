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
import { useOrderbookDeltaBadges } from '../../sidebar/orderbookDeltaBadges';
import BookPanel, { type BookTrade } from './BookPanel';
import BrokerTrajectoryTable from '../../sidebar/BrokerTrajectoryTable';
import TradeTickTable from '../../sidebar/TradeTickTable';
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
import { useLiveStockLimits } from '../../api/liveStockLimits';
import { useLiveViStatus } from '../../api/liveViStatus';
import {
  useLiveOrderbookAtCursor,
  useLiveBrokersAtCursor,
  useLiveBrokersToday,
} from '../../api/useLiveCursor';
import { useLiveVenueStore } from '../../state/liveVenue';
import { useChartPrefsStore } from '../../state/chartPrefs';
import { isMinuteTimeframe, type LiveTimeframe } from '../../state/livePage';
import { TIMEFRAME_TO_MS, type RangeSegment, type Timeframe } from '../../api/types';
import { isClosingAuction, type SessionSegment } from '../../util/sessionTime';
import {
  EMPTY_TRADE_SUMMARY,
  aggregateBrokerSeries,
  mergeBrokerSeriesWithLiveTail,
  latestOrderbookSnapshot,
  latestTradeSummary,
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
import { buildTradeTickView } from '../tradeTicks';
import { SectorRankingWindow } from './SectorRankingWindow';
import { isLiveIndexId } from '../liveInstrument';
import { WINDOW_KIND_LABEL } from './windowKindLabels';
import type { GroupId, GroupSymbol, WorkspaceWindow, WindowKind } from '../../state/workspace';

export function DataWindow({ win, symbol }: { win: WorkspaceWindow; symbol: GroupSymbol | null }) {
  // 섹터 랭킹은 지수 그룹 전용 데이터 창(PR-D) — 일반 지수 게이트보다 먼저 처리한다
  // (지수에서 유일하게 허용되는 kind). 주식·미지정 그룹에는 안내 카드.
  if (win.kind === 'sector-ranking') {
    if (symbol?.kind === 'index' && isLiveIndexId(symbol.code)) {
      return <SectorRankingWindow indexId={symbol.code} />;
    }
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg-subtle/40 text-center text-[11px] text-fg-dimmer">
        <span className="font-data">
          {WINDOW_KIND_LABEL[win.kind]} · 지수 그룹 전용
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
        <span className="font-data">
          {WINDOW_KIND_LABEL[win.kind]} · {symbol.name}
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
        <span className="font-data">
          {WINDOW_KIND_LABEL[win.kind]} · 종목 없음 (그룹 {win.group})
        </span>
      </div>
    );
  }
  switch (win.kind) {
    case 'book':
      return <BookWindow win={win} code={code} />;
    case 'broker':
      return <BrokerWindow win={win} code={code} />;
    case 'trade':
      return <TradeWindow code={code} />;
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
      <span className="font-data">
        {WINDOW_KIND_LABEL[kind]} · 차트 창 연동 대기
        <br />
        그룹 {group}에 차트 창을 추가하면 표시됩니다
      </span>
    </div>
  );
}

function BookWindow({ win, code }: { win: WorkspaceWindow; code: string }) {
  const venue = useLiveVenueStore((s) => s.venue);
  const live = useLiveSeries(code, venue);
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
  // ob/trade 는 useLiveSeries 가 선택 venue 로 소스에서 이미 필터한다(강제 경계) —
  // 창에서 재필터하지 않는다. 호가·체결강도·체결 미니리스트가 같은 venue 를 본다.
  const venueOb = live.ob;
  const venueTrade = live.trade;
  const latestSnapshot = useMemo(() => latestOrderbookSnapshot(venueOb), [venueOb]);
  // HTS식 순간 증감 뱃지 — 라이브 latest 표시일 때만. 스팟 커서 중에는 비활성
  // (과거 시점 위에 "방금 변화" 뱃지는 거짓 정보) + 상태도 비워 복귀 시 낡은 뱃지 방지.
  const deltaBadges = useOrderbookDeltaBadges(venueOb, !isSpot);
  const spotSnap = spotOrderbook === undefined ? undefined : spotOrderbook.snapshot;
  // 파케이 스팟이 비었을 때 WS 버퍼로 그 버킷의 실제 호가를 복원(ADR-0044 개정 —
  // 승격 지연 ~2-5분 커버). 레거시 LiveSidebar 폴백과 동일 조성.
  const bufferSnap = useMemo(
    () =>
      isSpot && spotSnap === null && spotTimeframe !== null && scope.cursorMs !== null
        ? orderbookSnapshotAtCursor(venueOb, scope.cursorMs, TIMEFRAME_TO_MS[spotTimeframe as Timeframe])
        : null,
    [isSpot, spotSnap, spotTimeframe, scope.cursorMs, venueOb],
  );
  const snapshot = resolveOrderbookCardSnapshot({
    scope,
    spotSnapshot: spotSnap,
    inactiveSnapshot: latestSnapshot,
    bufferFallbackSnapshot: bufferSnap,
  });
  const quote = useQuoteByCode([code], venue).get(code);
  const baselinePrice = quote?.baseline_price ?? null;
  // 상하한가·250일 최고/최저(ka10001) — 당일 고정값이라 스팟 커서에서도 유효.
  const stockLimits = useLiveStockLimits(code);
  // VI 이벤트 상태(키움 1h) — 예상 발동가의 기준가 갱신 + 발동 중 강조.
  const viStatus = useLiveViStatus(code);
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
  // 종목 요약 지표(체결강도·거래량·어제보다·VWAP·당일 OHLC)는 **latest 전용**이다.
  // 0B 가 실어 오는 값은 "지금 이 순간의 누적"이라 과거 커서(스팟) 시점의 값이
  // 아니다 — 스팟에서 latest 를 그대로 보여주면 호가는 과거인데 요약만 현재인
  // 시점 불일치가 생긴다. 그래서 스팟이면 비운다(패널이 "−" 로 렌더).
  const summary = useMemo(
    () => (isSpot ? EMPTY_TRADE_SUMMARY : latestTradeSummary(venueTrade)),
    [isSpot, venueTrade],
  );
  // 체결 리스트: 버퍼 엔트리 1건에 체결 여러 개가 실린다. 최신이 위로 오도록
  // 뒤에서부터 펼치고, 표시분(9행 — BookPanel 3열 바닥 정렬)보다 넉넉히 잡아 자른다.
  const recentTrades = useMemo(() => {
    if (isSpot) return [];
    const out: BookTrade[] = [];
    for (let i = venueTrade.length - 1; i >= 0 && out.length < 24; i--) {
      const rows = venueTrade[i].trades;
      if (!Array.isArray(rows)) continue;
      for (let j = rows.length - 1; j >= 0 && out.length < 24; j--) {
        const r = rows[j] as { price?: unknown; qty?: unknown; side?: unknown };
        if (typeof r?.price === 'number' && typeof r.qty === 'number') {
          out.push({ price: r.price, qty: r.qty, side: typeof r.side === 'number' ? r.side : 0 });
        }
      }
    }
    return out;
  }, [isSpot, venueTrade]);
  const lastPrice = recentTrades.length > 0 ? recentTrades[0].price : null;
  return (
    <div className="flex h-full flex-col">
      {showAvailableHint && (
        <div
          data-testid="orderbook-available-hint"
          className="px-3 py-1 font-data text-[11px] text-fg-dimmer"
        >
          다음 가용: {formatKstClock(availableFrom)}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <BookPanel
          snapshot={snapshot}
          baselinePrice={baselinePrice}
          summary={summary}
          trades={recentTrades}
          maskRatio={maskRatio}
          lastPrice={lastPrice}
          deltaBadges={isSpot ? null : deltaBadges}
          limits={stockLimits.data ?? null}
          vi={viStatus.data?.vi ?? null}
        />
      </div>
    </div>
  );
}

function BrokerWindow({ win, code }: { win: WorkspaceWindow; code: string }) {
  // broker 는 venue 무관이지만 useLiveSeries 시그니처가 venue 를 요구한다(ob/trade
  // 소스 필터 강제). broker 버퍼는 필터되지 않고 원본 그대로 온다.
  const venue = useLiveVenueStore((s) => s.venue);
  const live = useLiveSeries(code, venue);
  const { cursorMs, timeframe: cursorTimeframe } = useGroupCursor(win.group);
  const scope = resolveCursorDetailScope({ cursorMs, timeframe: cursorTimeframe });
  const spotSeries = useLiveBrokersAtCursor({
    code: scope.kind === 'minute-cursor' ? code : null,
    timeframe: scope.minuteTimeframe,
  });
  // latest 모드는 "당일 전체 누적" 이어야 한다(ADR-0044 2026-07-09 개정이 매물대에
  // 명시한 의미론 — 거래원에만 빠져 있었다). 승격된 당일 파케이를 본체로 삼고,
  // 승격 지연(≤약 5분 10초)으로 비는 꼬리만 WS 버퍼(15분)로 잇는다. 스팟 모드일
  // 때는 code=null 로 잠재워 불필요한 fetch 를 막는다.
  const todaySeries = useLiveBrokersToday(scope.kind === 'inactive' ? code : null);
  const liveTail = useMemo(() => aggregateBrokerSeries(live.broker), [live.broker]);
  const latestSeries = useMemo(
    () => mergeBrokerSeriesWithLiveTail(todaySeries, liveTail),
    [todaySeries, liveTail],
  );
  // 커서는 병합 시리즈의 마지막 관측 시각 — WS 버퍼가 아니라. 버퍼가 비어도
  // (장 초반·재접속 직후) 파케이 궤적이 있으면 값을 읽어야 한다. 버퍼만 보면
  // 그 경우 cursorMs=null 이 돼 궤적은 그려지는데 우측 값이 전부 "—" 가 된다.
  // 비었을 때 fallback 은 null — 시리즈도 비어 표시가 동일하므로 Date.now()(impure) 불필요.
  const latestTs = useMemo(() => {
    let max = -Infinity;
    for (const e of latestSeries) {
      const last = e.points[e.points.length - 1];
      if (last && last.ts_ms > max) max = last.ts_ms;
    }
    return Number.isFinite(max) ? max : null;
  }, [latestSeries]);
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
    <div className="h-full overflow-auto bg-bg-card">
      <BrokerTrajectoryTable series={card.series} cursorMs={card.cursorMs} />
    </div>
  );
}

/** 체결창 표시 상한 — 15분 버퍼에 수천 건이 쌓여도 렌더는 최근 이만큼만.
 *  스크롤로 과거를 훑는 창이 아니라 "지금 흐르는 체결"을 보는 창이다. */
const TRADE_TICK_LIMIT = 200;

/**
 * 체결창 — LATEST 전용(스팟 모드 없음).
 *
 * book·broker 와 달리 커서 스팟으로 전환하지 않는다. 파케이에 체결 틱 원본이
 * 남지 않아(저장 경로는 10초 (price,side) 집계) 과거 시점의 체결 목록을 복원할
 * 소스가 없고, WS 버퍼(15분)로만 잘라 보여주면 그 밖을 호버할 때 빈 창이 떠
 * 고장처럼 읽힌다. 체결 흐름의 과거 조회가 필요해지면 백엔드에 per-tick 보존
 * 경로를 먼저 만들어야 한다.
 */
function TradeWindow({ code }: { code: string }) {
  const venue = useLiveVenueStore((s) => s.venue);
  const live = useLiveSeries(code, venue);
  // live.trade 는 useLiveSeries 가 선택 venue 로 소스에서 이미 필터한다(강제 경계).
  // 없으면 KRX 선택에도 NXT 체결이 섞여 보인다(execution-window-datasource-policy).
  const view = useMemo(() => buildTradeTickView(live.trade, TRADE_TICK_LIMIT), [live.trade]);
  // 대량 체결 강조(⚙️ 설정 「체결창」, 전역 1벌). 설정은 만원 단위 — 원으로 환산해 전달.
  const highlightEnabled = useChartPrefsStore((s) => s.tradeHighlightEnabled);
  const thresholdManwon = useChartPrefsStore((s) => s.tradeHighlightThresholdManwon);
  const highlightColor = useChartPrefsStore((s) => s.tradeHighlightColor);
  const highlight = useMemo(
    () => (highlightEnabled
      ? { thresholdWon: thresholdManwon * 10_000, color: highlightColor }
      : null),
    [highlightEnabled, thresholdManwon, highlightColor],
  );
  return (
    // 배경을 10호가(BookPanel)와 동일한 --bg-card 로 — flat 창 프레임(--bg)이 비쳐
    // 체결창만 회색(Toss 라이트)으로 갈리던 것을 통일.
    <div className="h-full overflow-auto bg-bg-card">
      <TradeTickTable view={view} highlight={highlight} />
    </div>
  );
}

function InvestorWindow({ code }: { code: string }) {
  const query = useLiveInvestorTrendEstimate(code);
  return (
    <div className="h-full overflow-auto bg-bg-card">
      <InvestorTrendEstimateCard query={query} />
    </div>
  );
}

/** 링크 부재 시 매물대 설정 폴백(공장 기본과 동일 값) — 연동 대기 카드가 뜨는
 *  동안 비활성 훅에만 공급되므로 표시에는 쓰이지 않는다. */
const VDIST_FALLBACK = { rangeCount: 10, color: '#64748B', maxColor: '#EAB308', hoverCutoffEnabled: false };

function VdistWindow({ win, code }: { win: WorkspaceWindow; code: string }) {
  // 매물대는 live.trade 로 당일 분포를 잇는다 — useLiveSeries 가 선택 venue 로 소스에서
  // 필터하므로 매물대도 venue 정합(이전엔 원본 혼재 버퍼를 그대로 소비).
  const venue = useLiveVenueStore((s) => s.venue);
  const live = useLiveSeries(code, venue);
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
    <div className="h-full overflow-auto bg-bg-card">
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
  // 당일 종가 오버레이 — 순매수와 같은 번들의 candles 를 그대로 넘긴다(카드가
  // anchorT 날짜로 잘라 쓴다). program_trade 와 형제 필드라 축이 정확히 맞는다.
  const closePoints = useMemo(
    () => volumeDistributionClosePointsFromCandles(link?.bundle?.candles ?? []),
    [link?.bundle?.candles],
  );
  if (!linked) return <LinkPendingCard kind={win.kind} group={win.group} />;
  return (
    <div className="h-full overflow-auto bg-bg-card">
      <ProgramTradeSummaryCard
        series={link.bundle?.program_trade ?? null}
        cursorMs={scope.kind === 'minute-cursor' ? scope.cursorMs : null}
        closePoints={closePoints}
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
