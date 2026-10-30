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
import { lazy, Suspense, useMemo } from 'react';
import { BrokerScrollArea } from './BrokerScrollArea';
import { DataContext } from './DataContext';
import { useOrderbookDeltaBadges } from '../../sidebar/orderbookDeltaBadges';
import BookPanel from './BookPanel';
import { openTradeWindow } from './tradeWindowNavigation';
import { resolveBookBaseline } from './bookDisplay';
import { useRecentBookTrades } from './useRecentBookTrades';
import { useBookSessionDisplay } from './useBookSessionDisplay';
import { useOrderbookAvailability } from '../useOrderbookAvailability';
import { BookAvailabilityState } from './BookAvailabilityState';
import { useLiveRestOrderbook } from '../../api/liveRestOrderbook';
import { hasBookPrices } from '../../api/livePreAuctionBook';
import BrokerTrajectoryTable from '../../sidebar/BrokerTrajectoryTable';
import { TradeWindow } from './TradeWindow';
import { useTradeBrowseStore } from '../tradeBrowse';
import { ProgramTradeTickWindow } from './ProgramTradeTickWindow';
import ProgramTradeSummaryCard from '../../sidebar/ProgramTradeSummaryCard';
import { SecondVolumeDistributionWindow } from './SecondVolumeDistributionWindow';
import { VolumeDistributionCard } from '../../sidebar/VolumeDistributionCard';
import { InvestorTrendEstimateCard } from '../../sidebar/InvestorTrendEstimateCard';
import { InvestorDailyWindow } from './InvestorDailyWindow';
import {
  resolveBrokerCardProps,
  resolveCursorDetailScope,
  resolveOrderbookCursorScope,
  resolveOrderbookCardSnapshot,
} from '../../sidebar/cursorDetailResolver';
import { useLiveSeries } from '../../api/liveSeries';
import { useWallClockSecond } from '../../util/useWallClockSecond';
import { useLiveInvestorTrendEstimate } from '../../api/liveInvestorTrendEstimate';
import { useLiveDailyProgramTrade } from '../../api/liveDailyProgramTrade';
import { useDailyProgramTradeHistory } from '../useDailyProgramTradeHistory';
import { useProgramTradeDisplayStore } from '../../state/programTradeDisplay';
import { useQuoteByCode } from '../../api/liveQuotes';
import { useLiveKrxClose } from '../../api/liveKrxClose';
import { useLiveKrxPreviousClose } from '../../api/liveKrxPreviousClose';
import { useLiveStockLimits } from '../../api/liveStockLimits';
import { useLiveViStatus } from '../../api/liveViStatus';
import {
  useLiveOrderbookAtCursor,
  useLiveBrokersAtCursor,
  useLiveBrokersToday,
} from '../../api/useLiveCursor';
import { useScreenerDailyCandles, prevCloseBeforeDate } from '../../api/screenerDailyCandles';
import { useLiveVenueStore } from '../../state/liveVenue';
import { useEffectiveVenue } from '../useEffectiveVenue';
import { useChartPrefsStore } from '../../state/chartPrefs';
import { useWindowSettingsStore } from '../../state/windowSettings';
import { isSecondTimeframe, isMinuteTimeframe, type LiveTimeframe } from '../../state/livePage';
import { TIMEFRAME_TO_MS, type RangeSegment, type Timeframe } from '../../api/types';
import { isClosingAuction, type SessionSegment } from '../../util/sessionTime';
import {
  EMPTY_TRADE_SUMMARY,
  aggregateBrokerSeries,
  mergeBrokerSeriesWithLiveTail,
  aggregateProgramTrade,
  mergeProgramTradeWithLiveTail,
  latestOrderbookSnapshot,
  latestTradeSummary,
  fillTradeSummaryFromQuote,
  orderbookSnapshotAtCursor,
  orderbookSnapshotBeforeCursor,
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
  regularSessionBinningSegment,
  volumeDistributionClosePointsFromCandles,
} from '../continuousTradeVolumeDistribution';
import { realMsToYyyymmdd, subtractDaysKst, regularSessionOpenMs, regularSessionCloseMs } from '../liveDateTime';
import { SectorRankingWindow } from './SectorRankingWindow';
import { isLiveIndexId, isUsIndexId } from '../liveInstrument';
import { WINDOW_KIND_LABEL } from './windowKindLabels';
import type { GroupId, GroupSymbol, WorkspaceWindow, WindowKind } from '../../state/workspace';
import { useWorkspaceStore } from '../../state/workspace';
import { ExecutionHistoryWindow } from './ExecutionHistoryWindow';
import { NewsWindow } from './NewsWindow';
import { focusLiveSearch } from '../liveSearchFocus';
const OrderWindow = lazy(() => import('./OrderWindow').then(module => ({ default: module.OrderWindow })));

export function DataWindow({ win, symbol }: { win: WorkspaceWindow; symbol: GroupSymbol | null }) {
  if (win.kind === 'account-fills') return <ExecutionHistoryWindow win={win} />;
  if (symbol?.kind === 'us_stock' || (symbol?.kind === 'index' && isUsIndexId(symbol.code))) {
    return <div className="flex h-full items-center justify-center text-xs text-fg-dim">{symbol.name} · 미국 일봉 차트에서 조회할 수 있습니다</div>;
  }
  // 섹터 랭킹은 지수 그룹 전용 데이터 창(PR-D) — 일반 지수 게이트보다 먼저 처리한다
  // (지수에서 유일하게 허용되는 kind). 주식·미지정 그룹에는 안내 카드.
  if (win.kind === 'sector-ranking') {
    if (symbol?.kind === 'index' && isLiveIndexId(symbol.code)) {
      return <SectorRankingWindow indexId={symbol.code} group={win.group} />;
    }
    return (
      <div className="flex h-full w-full flex-col gap-2 items-center justify-center bg-bg-subtle/40 text-center text-xs text-fg-dim">
        <span className="font-data">
          {WINDOW_KIND_LABEL[win.kind]} · 지수 그룹 전용
          <br />
          {symbol ? `${symbol.name} 은 지수가 아닙니다` : `종목 없음 (그룹 ${win.group})`}
        </span>
        <button type="button" className="ui-choice" onClick={focusLiveSearch}>지수 검색</button>
      </div>
    );
  }
  // 지수는 호가/거래원/투자자 데이터가 없다 — 구독 오염 대신 안내 카드(C2c-2c).
  if (symbol?.kind === 'index') {
    return (
      <div className="flex h-full w-full flex-col gap-2 items-center justify-center bg-bg-subtle/40 text-center text-xs text-fg-dim">
        <span className="font-data">
          {WINDOW_KIND_LABEL[win.kind]} · {symbol.name}
          <br />
          지수는 지원하지 않습니다
        </span>
        <button type="button" className="ui-choice" onClick={focusLiveSearch}>종목 검색</button>
      </div>
    );
  }
  const code = symbol?.code ?? null;
  if (!code) {
    return (
      <div className="flex h-full w-full flex-col gap-2 items-center justify-center bg-bg-subtle/40 text-xs text-fg-dim">
        <span className="font-data">
          {WINDOW_KIND_LABEL[win.kind]} · 종목 없음 (그룹 {win.group})
          <br />그룹 {win.group}에서 종목 선택
        </span>
        <button type="button" className="ui-choice" onClick={focusLiveSearch}>종목 검색</button>
      </div>
    );
  }
  switch (win.kind) {
    case 'order':
      return <Suspense fallback={<div className="p-2 text-sm text-fg-dim">호가 주문창 불러오는 중…</div>}><OrderWindow code={code} name={symbol?.name ?? code}
        selectedAccountId={win.orderAccount}
        onResolvedAccount={account => useWorkspaceStore.getState().setOrderAccount(win.id, account)}
        onOpenExecutions={account => useWorkspaceStore.getState().openExecutionHistory(win.id, account)}
        onOpenTrades={() => openTradeWindow(win.id)}
        settings={win.order} onSelectSymbol={(nextCode, name) => { if (nextCode !== code) useWorkspaceStore.getState().setWindowSymbol(win.id, { code: nextCode, name }); }} onSettingsChange={settings => useWorkspaceStore.getState().setOrderWindowSettings(win.id, settings)} /></Suspense>;
    case 'news':
      return <NewsWindow key={code} code={code} name={symbol?.name ?? code} linkedOnly={win.newsLinkedOnly ?? true}
        onLinkedOnlyChange={value => useWorkspaceStore.getState().setNewsLinkedOnly(win.id, value)} />;
    case 'book':
      return <BookWindow win={win} code={code} />;
    case 'broker':
      return <BrokerWindow win={win} code={code} />;
    case 'trade':
      return <TradeWindow code={code} group={win.group} windowId={win.id} minAmountManwon={win.tradeMinAmountManwon ?? 0}
        onClearFilter={() => useWorkspaceStore.getState().setTradeMinAmountManwon(win.id, 0)} />;
    case 'program-trade':
      return <ProgramTradeTickWindow key={code} code={code} />;
    case 'investor':
      return <InvestorWindow code={code} />;
    case 'investor-daily':
      return <InvestorDailyPane win={win} code={code} />;
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
function useGroupCursor(group: GroupId, enabled = true): { cursorMs: number | null; timeframe: LiveTimeframe | null } {
  const cursorMs = useLiveCursorStore((s) => enabled && s.sidebarCursorOrigin?.group === group ? s.sidebarCursorMs : null);
  const origin = useLiveCursorStore((s) => enabled && s.sidebarCursorOrigin?.group === group ? s.sidebarCursorOrigin : null);
  if (cursorMs === null || origin === null || origin.group !== group) {
    return { cursorMs: null, timeframe: null };
  }
  return { cursorMs, timeframe: origin.timeframe };
}

function useGroupCursorDate(group: GroupId): string | null {
  return useLiveCursorStore((s) => s.sidebarCursorMs !== null && s.sidebarCursorOrigin?.group === group
    ? realMsToYyyymmdd(s.sidebarCursorMs) : null);
}

/** 매물대·프로그램의 연동 대기 카드 — 같은 그룹에 차트 창이 없을 때. */
function LinkPendingCard({ kind, group }: { kind: WindowKind; group: GroupId }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-bg-subtle/40 text-center text-xs text-fg-dim">
      <span className="font-data">
        {WINDOW_KIND_LABEL[kind]} · 차트 창 연동 대기
        <br />
        그룹 {group}에 차트 창을 추가하면 표시됩니다
      </span>
    </div>
  );
}

function BookWindow({ win, code }: { win: WorkspaceWindow; code: string }) {
  // 아래로 넘기는 것은 **선택값**이다. WS 꼬리(useLiveSeries)도 파케이 스팟
  // (useLiveOrderbookAtCursor)도 각자 `useEffectiveVenue` 로 같은 해석을 하므로
  // 데이터 경로에서는 미리 풀지 않는다 — 해석 지점이 둘로 갈리면 한쪽만 고쳐지는
  // 게 이 파일이 이미 겪은 실패다(useLiveCursor 의 VenueParam 주석).
  const selectedVenue = useLiveVenueStore((s) => s.venue);
  const tape = useTradeBrowseStore(s => s.session?.origin.group === win.group && s.session.origin.code === code ? s.session : null);
  const venue = tape?.seed.venue ?? selectedVenue;
  const live = useLiveSeries(code, venue);
  const chartCursor = useGroupCursor(win.group);
  const cursorMs = tape?.cursorMs ?? chartCursor.cursorMs;
  const cursorTimeframe = tape?.origin.timeframe ?? chartCursor.timeframe;
  const link = useGroupChartLink(win.group);
  // 초봉은 커서 이전 최근 호가, 분봉은 기존 봉 대표 호가를 조회한다.
  const scope = resolveOrderbookCursorScope({ cursorMs, timeframe: cursorTimeframe });
  const isSpot = scope.kind !== 'inactive';
  const spotTimeframe = scope.kind === 'second-cursor' ? scope.secondTimeframe : scope.minuteTimeframe;
  const {
    spot: spotOrderbook,
    stale: spotOrderbookStale,
    error: spotOrderbookError,
  } = useLiveOrderbookAtCursor({
    code: isSpot ? code : null,
    timeframe: spotTimeframe,
    cursorMs,
    venue,
    // 파케이 스팟은 디스크 캡처(원주가)라 차트 지표와 같은 척도로 옮겨야 한다.
    // 아래 `bufferSnap`·`latestSnapshot` 은 **WS 실시간 = 오늘**이고 오늘 계수는
    // 정의상 1.0 이라 환산이 no-op 이다 — 그래서 그 두 경로는 손대지 않는다.
    adjustFactors: link?.code === code ? link.adjustFactors : undefined,
  });
  // ob/trade 는 useLiveSeries 가 선택 venue 로 소스에서 이미 필터한다(강제 경계) —
  // 창에서 재필터하지 않는다. 호가·체결강도·체결 미니리스트가 같은 venue 를 본다.
  const venueOb = live.ob;
  const venueTrade = live.trade;
  // 시계가 경계를 넘으면 스스로 갱신되게 한다. 두 가지를 함께 떠받친다: 18:00 이후엔
  // 시간외 폴링이 멎어 '시간외 단일가' 라벨이 밤새 얼어붙고, 밤을 넘기면 아래
  // 공유 표시층의 전일 만료 판정이 갱신될 계기를 잃는다.
  const nowMs = useWallClockSecond();
  // Expiry belongs to the shared display layer, after resolving this Code's venue.
  // Historical cursor candidates remain untouched.
  const latestSnapshot = useMemo(() => latestOrderbookSnapshot(live.latestOb ? [live.latestOb] : venueOb),
    [venueOb, live.latestOb]);
  // HTS식 순간 증감 뱃지 — 라이브 latest 표시일 때만. 스팟 커서 중에는 비활성
  // (과거 시점 위에 "방금 변화" 뱃지는 거짓 정보) + 상태도 비워 복귀 시 낡은 뱃지 방지.
  const spotSnap = spotOrderbook === undefined ? undefined : spotOrderbook.snapshot;
  // 파케이 스팟이 비었을 때 WS 버퍼로 그 버킷의 실제 호가를 복원(ADR-0044 개정 —
  // 승격 지연 ~2-5분 커버). 레거시 LiveSidebar 폴백과 동일 조성.
  const bufferSnap = useMemo(
    () =>
      scope.kind === 'second-cursor'
        ? orderbookSnapshotBeforeCursor(venueOb, scope.cursorMs)
        : isSpot && spotSnap === null && spotTimeframe !== null && scope.cursorMs !== null
        ? orderbookSnapshotAtCursor(venueOb, scope.cursorMs, TIMEFRAME_TO_MS[spotTimeframe as Timeframe])
        : null,
    [isSpot, spotSnap, spotTimeframe, scope.kind, scope.cursorMs, venueOb],
  );
  const regularSnapshot = resolveOrderbookCardSnapshot({
    scope, spotSnapshot: spotSnap, inactiveSnapshot: latestSnapshot, bufferFallbackSnapshot: bufferSnap,
  });
  const todayKst = link?.todayKst ?? realMsToYyyymmdd(nowMs);
  const lastValidSnapshot = useMemo(() => latestOrderbookSnapshot(live.lastValidOb ? [live.lastValidOb] : []), [live.lastValidOb]);
  const preAuctionSnapshot = useMemo(() => latestOrderbookSnapshot(live.preAuctionOb ? [live.preAuctionOb] : []), [live.preAuctionOb]);
  const { snapshot, ladderSource, bookFresh, monitorBook, activeSinglePrice, singlePriceFills, afterHoursBook, effectiveVenue, aftermarketExclusion,
    allowRestBook, afterHoursTotals, afterHoursLabel, sessionControl, sessionMode, selectSessionMode, bookQuery } = useBookSessionDisplay({
    code, venue, nowMs, todayKst, isSpot, regularSnapshot, latestSnapshot, lastValidSnapshot, preAuctionSnapshot, afterHours: live.afterHours,
  });
  // Current REST data must never fill a historical cursor or replace a
  // selected single-price session. Both book windows share the same query key.
  const needsRestBook = allowRestBook && !isSpot && !hasBookPrices(snapshot) && activeSinglePrice === null
    && !(sessionControl.kind === 'toggle' && sessionMode === 'afterHours');
  const rest = useLiveRestOrderbook(code, effectiveVenue, needsRestBook && !live.isLoading);
  const restBook = needsRestBook && rest.data?.code === code && rest.data.venue === effectiveVenue
    ? rest.data.book : null;
  const displayedBook = restBook ?? (needsRestBook ? null : snapshot);
  const deltaBadges = useOrderbookDeltaBadges(venueOb, bookFresh && !restBook);
  const quote = useQuoteByCode([code], venue).get(code);
  // 등락률 기준가는 **커서가 보고 있는 날짜**의 전일종가여야 한다.
  //
  // quote.baseline_price 는 언제나 "오늘 기준" 전일종가다(백엔드 QuoteChangeResolver
  // 가 `date < today` 로 잘라 온다). 그래서 어제 캔들을 호버하면 분자(호가)만 과거로
  // 바뀌고 분모는 오늘에 남아, 가격은 맞는데 등락률·방향색만 통째로 틀렸다
  // — 2026-08-03 실측: 7/30 10:00 매수1호가 210,000 이 **−20.00%** 로 찍혔다
  // (분모 262,500=7/31 종가). 정답은 7/30 기준가 208,500 대비 **+0.72%** 로, 크기가
  // 아니라 **부호가 뒤집히는** 오류였다.
  //
  // 같은 BookPanel 을 쓰는 /study 의 BookContent 는 처음부터 커서 날짜의 전일종가를
  // 썼다 — 표시 컴포넌트는 통일해 놓고 자료 조달만 두 벌로 갈라져 한쪽만 옳았다.
  // `todayKst` 는 위 총잔량 날짜 가드와 공유한다(그쪽이 먼저 필요해 앞으로 올렸다).
  const cursorDate = isSpot && scope.cursorMs !== null ? realMsToYyyymmdd(scope.cursorMs) : null;
  const isPastDateCursor = cursorDate !== null && cursorDate < todayKst;
  // 조회창은 **오늘까지 한 벌로 고정**한다. /study 처럼 to 를 커서 날짜로 잡으면
  // 커서가 날짜를 넘을 때마다 쿼리 키가 새로 생기는데, /live 는 분봉을 며칠씩
  // 가로지르며 호버하는 표면이라 키가 날짜 수만큼 불어난다. to=오늘 고정이면 키가
  // 하나뿐이라 날짜 사이를 오가도 재요청이 없다. 60일이면 연휴가 끼어도 직전
  // 거래일이 반드시 창 안에 들어온다.
  const baselineCandles = useScreenerDailyCandles(
    isPastDateCursor ? code : null,
    subtractDaysKst(todayKst, 60),
    todayKst,
  );
  // 분모의 날짜는 커서가 아니라 **사다리에 실제로 그려지는 스냅샷**의 날짜다.
  //
  // 커서 날짜로 잡으면 스팟 조회가 비행 중일 때 분자(아직 옛 스냅샷)와 분모(벌써
  // 새 날짜)가 갈려, 있지도 않았던 등락률의 프레임이 뜬다 — `/study` 에서 실측된
  // 그 버그와 같은 것이고(2026-08-20: 같은 가격 26,050 이 −1.51%→+2.76%), 같은
  // 훅을 쓰는 이 창도 구조상 같은 상태를 지난다. 사다리가 자기 시각을 싣고 있으니
  // 그것을 따라가면 늦은 프레임도 정합하고, 낡았다는 사실은 딤이 말한다.
  //
  // `isPastDateCursor` 는 **그대로 둔다** — 상하한가·250일(`spotLimits`)의 게이트는
  // "사용자가 어느 날짜를 보고 있나" 라서 축이 다르고, 그쪽은 보수적인 편이 옳다.
  const ladderDate = snapshot != null ? realMsToYyyymmdd(snapshot.ts_ms) : cursorDate;
  const isPastDateLadder = ladderDate !== null && ladderDate < todayKst;
  const ladderBaseline = useMemo(
    () =>
      ladderDate !== null && isPastDateLadder
        ? prevCloseBeforeDate(baselineCandles.data?.candles ?? [], ladderDate)
        : null,
    [ladderDate, isPastDateLadder, baselineCandles.data],
  );
  // change_pct_source==='unavailable' = 백엔드가 기준가를 **못 믿겠다고 판정한** 상태
  // (adjusted_baseline_stale · adjusted_baseline_scale_mismatch). 그때 백엔드는
  // change_pct 를 null 로 죽이면서도 baseline_price 는 그대로 실어 보낸다. 이 패널은
  // change_pct 를 쓰지 않고 baseline_price 로 직접 등락률을 계산하므로, 그냥 두면
  // **봉인된 판정을 뚫고** 값을 그린다 — 종목 리스트는 숨기는데 호가창만 표시되는
  // 비대칭이 된다. 여기서 함께 봉인해 대시로 떨어뜨린다.
  const liveBaseline =
    quote?.change_pct_source === 'unavailable' ? null : (quote?.baseline_price ?? null);
  // 시간외 단일가(16:00–18:00)는 **분모가 다르다** — 그 구간의 거래는 당일 종가
  // ±10% 안에서 이뤄지므로 전일종가 기준 등락률은 화면에서 의미가 없다. 종가가
  // 곧 0% 여야 한다. 벤더도 자기 `change_pct` 를 종가 기준으로 주는데, 사다리만
  // 정규장 분모(`liveBaseline` = 전일종가)를 쓰고 있어 한 창 안에 **두 기준이
  // 섞여** 있었다(실측 2026-08-18 16:20, 028050: 요약의 −0.42% 는 종가 47,900
  // 기준인데 같은 화면 사다리의 47,900 은 −3.82% = 전일종가 49,800 기준).
  //
  // `close_price` 가 null 이면 **등락률을 생략한다**(분모 추측 금지) — 아래
  // `??` 가 아니라 조건 분기인 이유가 그것이다. `?? liveBaseline` 로 떨어뜨리면
  // 모름이 조용히 전일종가로 대체돼 원래 버그가 그대로 돌아온다.
  // 과거 날짜 커서면 일봉에서 뽑은 그날의 기준가. 로딩 중이면 null(등락률 생략) —
  // 틀린 값을 잠깐 보여주느니 비는 편이 옳다.
  const baselinePrice = resolveBookBaseline({
    isPastDateLadder,
    ladderBaseline,
    singlePriceActive: activeSinglePrice !== null,
    singlePriceClose: afterHoursBook.data?.close_price ?? null,
    liveBaseline,
  });
  // 상하한가·250일 최고/최저(ka10001) — **오늘의** 값이다. 당일 안에서는 시각이
  // 달라져도 고정이라 오늘 스팟 커서에서 유효하지만, 과거 날짜 커서에서는 그날의
  // 기준가에서 파생된 상하한가와 다르므로 아래에서 비운다.
  const stockLimits = useLiveStockLimits(code);
  const krxClose = useLiveKrxClose(isSpot ? null : code, todayKst);
  const quoteDate = realMsToYyyymmdd(nowMs);
  const krxPreviousClose = useLiveKrxPreviousClose(isSpot ? null : code, quoteDate);
  // VI 이벤트 상태(키움 1h) — 예상 발동가의 기준가 갱신 + 발동 중 강조.
  const viStatus = useLiveViStatus(code, effectiveVenue);
  // 동시호가 마스크: 링크 기준 차트 창의 표시 설정을 따른다. 판정은 링크
  // 차트 창 번들의 세션 세그먼트로 — 전역 axis store 는 멀티창 last-writer-wins 라
  // 부정확. 링크 부재/비스팟이면 마스크 없음(latest 는 레거시도 비활성).
  const legacyAuctionMask = useChartPrefsStore((s) => s.auctionWindowMask);
  const auctionWindowMask = useWindowSettingsStore(state =>
    (link ? state.byWindow[link.windowId]?.chart?.auctionWindowMask : undefined) ?? legacyAuctionMask);
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
  // 형성 중 봉 힌트 — 커서가 **아직 닫히지 않은 봉**을 가리키면 그 봉의 대표 호가는
  // 정의상 확정 전이라 틱마다 갱신된다(`orderbookSnapshotAtCursor` = 버킷의 마지막
  // continuous book, 백엔드 `query_bucket_representative` 와 맞춘 계약). 실측
  // 2026-08-12 장중: 형성 중 봉 42초에 잔량 27회 변동 / 닫힌 봉은 55~106초에 0~1회.
  // 값이 흐르는 것이 고장이 아니라는 것을 화면에서 읽히게 한다.
  //
  // **판정을 `Date.now()` 로 하지 않는다** — 렌더 중 호출이 impure 이고 매 렌더 값이
  // 달라 memo 가 불안정해진다(`useLiveBrokersToday` 의 stampMs 주석이 같은 함정을
  // 기록해 뒀다). 대신 링크 차트 창 번들의 **마지막 캔들**로 유도한다: 장중이면 그것이
  // 곧 형성 중 봉이고, 데이터 파생이라 새 봉이 생기면 저절로 따라간다.
  //
  // `link.timeframe !== spotTimeframe` 이면 판정하지 않는다 — 그룹에 차트 창이 여럿일
  // 때 링크 발행자(z-최상위)와 호버 발행자가 다른 봉일 수 있고, 그러면 버킷 경계가
  // 서로 다른 축이라 비교가 성립하지 않는다.
  //
  // `spotSnap === null && bufferSnap !== null` 이 마감 후 오표시를 막는다: 승격이
  // 끝나면 파케이가 답하므로(그때는 값이 고정) 힌트가 저절로 사라진다.
  const spotBucketMs = scope.kind === 'minute-cursor' && spotTimeframe !== null ? TIMEFRAME_TO_MS[spotTimeframe as Timeframe] : null;
  const linkLastCandleMs =
    link !== null && link.bundle !== null && link.bundle.candles.length > 0
      ? link.bundle.candles[link.bundle.candles.length - 1].ts_ms
      : null;
  const showFormingHint = !!(
    isSpot &&
    scope.cursorMs !== null &&
    spotBucketMs !== null &&
    link !== null &&
    link.timeframe === spotTimeframe &&
    linkLastCandleMs !== null &&
    Math.floor(scope.cursorMs / spotBucketMs) === Math.floor(linkLastCandleMs / spotBucketMs) &&
    spotSnap === null &&
    bufferSnap !== null
  );
  // 종목 요약 지표(체결강도·거래량·어제보다·VWAP·당일 OHLC)는 **latest 전용**이다.
  // 0B 가 실어 오는 값은 "지금 이 순간의 누적"이라 과거 커서(스팟) 시점의 값이
  // 아니다 — 스팟에서 latest 를 그대로 보여주면 호가는 과거인데 요약만 현재인
  // 시점 불일치가 생긴다. 그래서 스팟이면 비운다(패널이 "−" 로 렌더).
  //
  // 일곱 칸(시·고·저 + 거래량·거래대금·어제보다·체결강도)은 시세 오버레이(`quote`)가
  // 뒤를 받친다 — 마감 후 표시 링버퍼가 비면 0B 가 통째로 사라져 요약이 전 칸 대시가
  // 되기 때문이다(근거·규약은 `fillTradeSummaryFromQuote`).
  //
  // **폴백도 같은 `isSpot` 게이트 안에 둔다.** `quote` 는 정의상 "지금" 값이라, 과거
  // 커서 위에 얹으면 바로 위 주석이 막으려던 시점 불일치를 폴백이 되살린다.
  //
  // venue 는 이미 맞아 있다 — 두 입력이 같은 유효 venue 를 탄다(`venueTrade` 는
  // `useLiveSeries` 가 필터, `quote` 는 `useLiveQuoteOverlay` 가 코드별로 해석).
  const summary = useMemo(
    () => (isSpot ? EMPTY_TRADE_SUMMARY : fillTradeSummaryFromQuote(latestTradeSummary(venueTrade), quote)),
    [isSpot, venueTrade, quote],
  );
  // Seed recent executions from the tape's shared REST cache, then
  // merge the live tail. Current-day history must never leak into a past cursor.
  const recentTrades = useRecentBookTrades({ code, date: todayKst, venue: effectiveVenue,
    frames: venueTrade, enabled: !isSpot && activeSinglePrice === null });
  // 시간외 단일가 구간에는 **합성 체결**이 체결창을 채운다. WS 체결(0B)은 16:00 에
  // 끊기므로 `recentTrades` 는 그때부터 15:59 의 화석이고, 그것을 "지금 흐르는 체결"
  // 자리에 두면 시각이 안 보이는 만큼 조용히 거짓이 된다.
  //
  // ⚠ 판정에 `showAfterHours` 가 들어간다 — 갈래 A 의 정규장 모드에서는 시간외
  // 응답이 도착해 있어도 **쓰지 않는다.** 사다리만 정규장으로 되돌리고 체결창은
  // 시간외 체결을 그리면 한 창이 두 장을 동시에 보이게 된다.
  const useSinglePrice = activeSinglePrice !== null;
  const bookTrades = useSinglePrice ? singlePriceFills : recentTrades;
  // 사다리에서 현재가 행을 강조하는 값. 시간외에는 벤더 현재가를 **직접** 쓴다 —
  // 체결창이 비어 있을 수 있고(첫 관측은 기준선이라 행이 없다), 15:59 가격은 시간외
  // 5단 어디에도 없어 강조가 사라지거나 엉뚱한 행에 붙는다.
  const lastPrice = useSinglePrice
    ? (afterHoursBook.data?.cur_price ?? null)
    : recentTrades.length > 0
      ? recentTrades[0].price
      : null;
  // 상하한가·250일은 **날짜** 단위 상수다 — 오늘 스팟(시각만 과거)에서는 유효하고
  // 과거 날짜에서만 거짓이라, 시각 단위 누적인 summary 와 게이트가 다르다.
  const spotLimits = isPastDateCursor ? null : (stockLimits.data ?? null);
  // VI 는 "지금 발동 중"이라는 **현재 상태**라 과거 시각 위에서는 날짜와 무관하게
  // 거짓이다 — 당일 스팟에서도 비운다(deltaBadges 와 같은 근거). vi=null 이면 ViRow
  // 가 기준가에서 예상 발동가를 계산하는데, 스팟에선 summary(dayOpen)도 비고 과거
  // 날짜면 limits(base_price)도 비므로 base 가 없어 대시로 떨어진다.
  const spotVi = isSpot ? null : (viStatus.data?.vi ?? null);
  // 시간외 단일가 사다리는 스팟 경로가 아니다 — 그쪽이 사다리를 통째로 대체하고
  // 있으면 스팟 조회의 신선도는 화면에 그려진 것과 무관하다.
  const bookStale = !useSinglePrice && spotOrderbookStale;
  const { availability, retry: retryBook } = useOrderbookAvailability({ code, venue: effectiveVenue,
    live, bookMs: snapshot?.ts_ms, nowMs, exclusion: aftermarketExclusion,
    hasBook: hasBookPrices(snapshot) || !!restBook, bookQuery,
    rest: { enabled: needsRestBook, loading: live.isLoading || rest.isLoading, isError: rest.isError, data: rest.data,
      retry: () => rest.refetch({ cancelRefetch: false }) },
    enabled: monitorBook && afterHoursTotals === null
      && !(sessionControl.kind === 'toggle' && sessionMode === 'afterHours') });
  const bookAvailability = <BookAvailabilityState state={availability} onRetry={retryBook}
    testId={needsRestBook && !restBook ? 'book-empty-book' : undefined}
    reference={restBook ? { testId: 'book-rest-book-source',
      text: `${rest.data?.source === 'stored' ? '저장된 마지막 호가' : 'REST 마지막 호가'} · ${restBook.book_time ?? '시각 미제공'} · ${effectiveVenue === 'UN' ? '통합' : effectiveVenue} · 거래일 미제공` } : undefined} />;
  // 조회 중에는 안내 행을 추가하지 않아 호가 사다리의 위치를 유지한다.
  const bookContextMode = scope.kind === 'second-cursor' ? '저장 호가' : null;
  // 스팟 조회 실패는 **패널을 대체한다**(칩으로 얹지 않는다). `useSpot` 이 실패분을
  // 비우므로 사다리는 `undefined` 로 떨어져 "커서 위치 불러오는 중…" 을 그리는데,
  // 그 위에 실패 칩을 얹으면 한 화면이 "실패했다" 와 "불러오는 중" 을 동시에
  // 말한다. `/study` 의 BookContent 와 같은 처리 — 같은 패널을 쓰는 두 화면이
  // 같은 실패에 다른 모양을 내면 안 된다.
  if (isSpot && spotOrderbookError !== null) {
    return (
      <div
        data-testid="orderbook-spot-error"
        className="flex h-full w-full flex-col items-center justify-center gap-1 px-3 text-center"
      >
        <span className="font-data text-xs" style={{ color: 'var(--error)' }}>
          호가 불러오기 실패
        </span>
        <span className="text-2xs text-fg-dim">커서를 다시 움직이면 재시도합니다</span>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col">
      {isSpot && (bookContextMode !== null || showAvailableHint || showFormingHint) && <DataContext
        mode={bookContextMode ?? ''}
        time={bookContextMode !== null ? snapshot?.ts_ms : undefined}
        tone={bookContextMode !== null ? 'cursor' : undefined}>
        {/* 일반 커서 라벨 대신 데이터 공백·형성 중 상태만 안내한다. */}
        {showAvailableHint && (
          <span
            data-testid="orderbook-available-hint"
            className="truncate"
            data-tooltip={`다음 가용: ${formatKstClock(availableFrom)}`}
          >
            다음 가용: {formatKstClock(availableFrom)}
          </span>
        )}
        {/* 위 힌트와 배타적이다 — 저쪽은 `bufferSnap === null`(진짜 공백), 이쪽은
            `bufferSnap !== null`(버퍼가 답하는 중). 자리·토큰을 공유해 둘이 같은
            "덜 확정된 상태" 라는 말임을 유지한다. */}
        {showFormingHint && (
          <span
            data-testid="orderbook-forming-hint"
            className="truncate"
            data-tooltip="형성 중 · 실시간"
          >
            형성 중 · 실시간
          </span>
        )}
      </DataContext>}
      <div className="book-status-host">
        {(hasBookPrices(snapshot) || restBook) && <div className="book-status-overlay">{bookAvailability}</div>}
        <BookPanel
          symbol={code}
          emptyState={isSpot && snapshot === null
            ? <div className="m-auto text-xs text-fg-dim">선택 시점의 저장 호가 없음</div>
            : availability ? bookAvailability : undefined}
          snapshot={displayedBook}
          showEmptySummary={!restBook && !hasBookPrices(snapshot)}
          expectedFill={restBook || ladderSource === 'saved' ? null : isSpot || activeSinglePrice !== null ? undefined
            : { price: quote?.expected_price ?? 0, qty: quote?.expected_qty ?? null }}
          afterHoursTotals={restBook ? null : afterHoursTotals}
          afterHoursLabel={afterHoursLabel}
          sessionControl={restBook ? { kind: 'label', label: '마지막 조회 호가' } : sessionControl}
          sessionMode={sessionMode}
          onSelectSessionMode={selectSessionMode}
          baselinePrice={baselinePrice}
          krxClose={!isSpot && krxClose.data?.date === todayKst ? krxClose.data.price : null}
          krxPreviousClose={!isSpot && krxPreviousClose.data?.as_of === quoteDate ? krxPreviousClose.data.price : null}
          summary={summary}
          trades={bookTrades}
          tradeScopeKey={`${todayKst}:${effectiveVenue}:${scope.kind}:${scope.cursorMs ?? ''}:${activeSinglePrice !== null}`}
          onOpenTrades={() => openTradeWindow(win.id)}
          maskRatio={maskRatio}
          lastPrice={lastPrice}
          deltaBadges={isSpot ? null : deltaBadges}
          limits={spotLimits}
          vi={spotVi}
          stale={!restBook && (bookStale || availability?.lastBookMs !== undefined)}
        />
      </div>
    </div>
  );
}

function BrokerWindow({ win, code }: { win: WorkspaceWindow; code: string }) {
  // venue 는 시그니처 요구가 아니라 **실제 필터 키**다. 아래 세 경로가 같은 venue 를
  // 타야 한다: WS 꼬리(live.broker) · 스팟(useLiveBrokersAtCursor) · 당일 누적
  // (useLiveBrokersToday). 하나만 어긋나면 병합 시리즈에서 시장이 섞인다.
  //
  // **데이터 경로에는 선택값을 넘긴다** — 세 훅이 각자 `useEffectiveVenue` 로
  // 종목별 유효 venue 를 해석하기 때문이다(WS 꼬리는 liveSeries.ts 의
  // filterByVenueTag, 나머지 둘은 URL·캐시 키). 예전엔 훅 두 개가 선택값을 그대로
  // 백엔드에 보내서, NXT 미상장 종목 + UN 선택이면 창이 통째로 비었다(#1209 후속,
  // 근거·실측은 useLiveCursor 의 VenueParam 주석).
  //
  // 표시층만 예외다 — 아래 `effectiveVenue` 는 prop 이라 훅이 삼킬 자리가 없어
  // 호출부가 해석해 넘긴다(#1209).
  const venue = useLiveVenueStore((s) => s.venue);
  const live = useLiveSeries(code, venue);
  // 표시 창(클립·x축)은 **유효** venue 로 정한다 — 선택값 그대로면 NXT 미상장 종목에
  // 통합을 고른 화면이 데이터는 KRX(15:30 까지)인데 축만 20:00 까지 늘어난다.
  // useLiveSeries 는 같은 해석을 내부에서 삼키므로(프레임 필터) 여기서만 다시 구한다.
  const effectiveVenue = useEffectiveVenue(code, venue);
  const { cursorMs, timeframe: cursorTimeframe } = useGroupCursor(win.group);
  const scope = resolveCursorDetailScope({ cursorMs, timeframe: cursorTimeframe });
  const spotSeries = useLiveBrokersAtCursor({
    code: scope.kind === 'minute-cursor' ? code : null,
    timeframe: scope.minuteTimeframe,
    venue,
  });
  // latest 모드는 "당일 전체 누적" 이어야 한다(ADR-0044 2026-07-09 개정이 매물대에
  // 명시한 의미론 — 거래원에만 빠져 있었다). 승격된 당일 파케이를 본체로 삼고,
  // 승격 지연(≤약 5분 10초)으로 비는 꼬리만 WS 버퍼(15분)로 잇는다. 스팟 모드일
  // 때는 code=null 로 잠재워 불필요한 fetch 를 막는다.
  const todaySeries = useLiveBrokersToday(scope.kind === 'inactive' ? code : null, venue);
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
    <div className="flex h-full flex-col bg-bg-card">
      <BrokerScrollArea>
      <BrokerTrajectoryTable
        series={card.series}
        cursorMs={card.cursorMs}
        venue={effectiveVenue}
      />
      </BrokerScrollArea>
    </div>
  );
}

/** 일별 투자자 — 커서 날짜만 위에서 풀어 넘긴다.
 *
 *  `useGroupCursorDate` 를 표 컴포넌트 안에서 부르지 않는 이유: 그러면 표가 워크스페이스
 *  스토어에 묶여 단위 테스트가 그룹 배선까지 세워야 한다. 거래원·프로그램 창과 같은
 *  의미론(같은 링크 그룹 차트의 호버만 통과)을 여기 한 겹에서 해석한다.
 */
function InvestorDailyPane({ win, code }: { win: WorkspaceWindow; code: string }) {
  const cursorDate = useGroupCursorDate(win.group);
  return <InvestorDailyWindow code={code} cursorDate={cursorDate} />;
}

function InvestorWindow({ code }: { code: string }) {
  const query = useLiveInvestorTrendEstimate(code);
  return (
    <div className="flex h-full flex-col bg-bg-card">
      <div className="min-h-0 flex-1 overflow-auto"><InvestorTrendEstimateCard query={query} /></div>
    </div>
  );
}

/** 링크 부재 시 매물대 설정 폴백(공장 기본과 동일 값) — 연동 대기 카드가 뜨는
 *  동안 비활성 훅에만 공급되므로 표시에는 쓰이지 않는다. */
const VDIST_FALLBACK = { regularSessionOnly: false, rangeCount: 10, color: '#64748B', maxColor: '#EAB308', hoverCutoffEnabled: false };

function VdistWindow({ win, code }: { win: WorkspaceWindow; code: string }) {
  const link = useGroupChartLink(win.group);
  return link?.code === code && isSecondTimeframe(link.timeframe)
    ? <SecondVolumeDistributionWindow win={win} code={code} settings={link.vdist} timeframe={link.timeframe} date={link.secondDate ?? link.todayKst} />
    : <LegacyVdistWindow win={win} code={code} />;
}

function LegacyVdistWindow({ win, code }: { win: WorkspaceWindow; code: string }) {
  // 매물대는 live.trade 로 당일 분포를 잇는다 — useLiveSeries 가 선택 venue 로 소스에서
  // 필터하므로 매물대도 venue 정합(이전엔 원본 혼재 버퍼를 그대로 소비).
  const venue = useLiveVenueStore((s) => s.venue);
  const live = useLiveSeries(code, venue);
  const effectiveVenue = useEffectiveVenue(code, venue);
  const link = useGroupChartLink(win.group);
  // 링크의 code 가 창의 code 와 다르면(그룹 종목 교체 직후 발행 지연 프레임) 소비하지
  // 않는다 — 이전 종목 번들이 새 종목 창에 새는 것을 막는 가드.
  const linked = link !== null && link.code === code;
  const bundle = linked ? link.bundle : null;
  const timeframe = linked ? link.timeframe : null;
  const todayKst = linked ? link.todayKst : '';
  const vdistSettings = linked ? link.vdist : VDIST_FALLBACK;
  const regularOnly = linked && link.vdist.regularSessionOnly === true && timeframe !== null && isMinuteTimeframe(timeframe);
  const { cursorMs, timeframe: cursorTimeframe } = useGroupCursor(win.group);
  const scope = resolveCursorDetailScope({ cursorMs, timeframe: cursorTimeframe });
  const isSpot = scope.kind === 'minute-cursor';
  const spotCursorMs = isSpot ? scope.cursorMs : null;
  const spotTimeframe = isSpot ? scope.minuteTimeframe : null;

  // ── 이하 조성은 레거시 LiveSidebar 의 매물대 경로 이식(#719 플립으로 삭제된
  //    LiveSidebar.tsx — 활성 날짜 선정·오늘 증분 fold·호버 컷오프·종가 라인). ──
  // latest 는 오늘 스코프(ADR-0044 "당일 전체 누적") — 거래원·프로그램 창과 같은
  // 의미론. 번들 마지막 세그먼트를 쓰면 새날 아침(오늘 캡처 부재)에 전일 분포가
  // 날짜 라벨 없이 현재값처럼 남고, 마커(마지막 체결 = 오늘 시각)까지 전일
  // 히스토그램 위에 겹친다. 오늘 데이터가 없으면 빈 상태("매물대 분포 없음")가 맞다.
  const activeDate = spotCursorMs !== null
    ? realMsToYyyymmdd(spotCursorMs)
    : (todayKst || null);
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
  // 집계에 넘기는 segment 는 전부 정규장으로 좁힌다 — venue=UN 의 확장창
  // (08:00~20:00)이 그대로 들어오면 bar 에 NXT 프리·애프터 체결이 섞이고, 백엔드가
  // 산출하는 과거일 분포(정규장 고정)와 기준이 어긋난다. 표시 축은 실제 가격
  // 데이터 범위를 사용하므로 NXT 가격이 있을 때만 그 시간대까지 이어진다.
  const todayContinuousBeforeMs = useMemo(() => {
    if (!bundle || !todayKst) return null;
    const todaySegment = bundle.segments.find((segment) => segment.date === todayKst);
    if (!todaySegment) return null;
    return firstTrailingSinglePriceBookMs(
      live.ob,
      regularSessionBinningSegment(todaySegment, effectiveVenue).session_close_ms,
      regularSessionBinningSegment(todaySegment, effectiveVenue).session_open_ms,
      effectiveVenue,
    );
  }, [bundle, todayKst, live.ob, effectiveVenue]);
  // 원본(축용) — 확장창이면 확장창 그대로.
  const activeSegment = useMemo(
    () => bundle?.segments.find((segment) => segment.date === activeDate) ?? null,
    [bundle, activeDate],
  );
  const todaySegment = useMemo(() => {
    const raw = bundle?.segments.find((segment) => segment.date === todayKst) ?? null;
    return raw ? { ...regularSessionBinningSegment(raw, effectiveVenue), venue: effectiveVenue } : null;
  }, [bundle, todayKst, effectiveVenue]);
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
      !regularOnly && activeProfile
      && Number.isFinite(activeProfile.price_min)
      && Number.isFinite(activeProfile.price_max)
      && activeProfile.price_min < activeProfile.price_max
    ) {
      return { min: activeProfile.price_min, max: activeProfile.price_max };
    }
    return candleRangeUnbounded(activeCandles);
  }, [activeProfile, activeCandles, regularOnly]);
  const regularCutoffMs = regularOnly && activeDate ? Math.min(
    regularSessionCloseMs(activeDate),
    vdistSettings.hoverCutoffEnabled && spotCursorMs !== null ? spotCursorMs : Infinity,
  ) : undefined;
  // Keep these inputs stable while the cursor moves within a date. Recreating
  // either reference discards the cutoff hook's trade prefix index.
  const cutoffTrades = useMemo(() => {
    if (!regularOnly) return liveDistribution.trades;
    const date = activeDate ?? todayKst;
    const open = regularSessionOpenMs(date), close = regularSessionCloseMs(date);
    return liveDistribution.trades.filter(trade => trade.t_ms >= open && trade.t_ms <= close);
  }, [regularOnly, activeDate, todayKst, liveDistribution.trades]);
  const cutoffSegment = useMemo(() => {
    if (!activeSegment) return null;
    return regularOnly
      ? { ...activeSegment, session_open_ms: regularSessionOpenMs(activeSegment.date), session_close_ms: regularSessionCloseMs(activeSegment.date) }
      : { ...regularSessionBinningSegment(activeSegment, effectiveVenue), venue: effectiveVenue };
  }, [activeSegment, regularOnly, effectiveVenue]);
  const cutoffProfile = useVolumeDistributionCutoffProfile({
    enabled: linked && ((vdistSettings.hoverCutoffEnabled && isSpot) || regularOnly),
    exactCutoffMs: regularCutoffMs,
    regularSessionOnly: regularOnly,
    code,
    timeframe: regularOnly && timeframe !== null && isMinuteTimeframe(timeframe) ? timeframe : spotTimeframe,
    date: activeDate,
    cursorMs: regularCutoffMs ?? spotCursorMs,
    todayKst: todayKst || null,
    rangeCount: vdistSettings.rangeCount,
    finalProfile: regularOnly ? null : activeProfile,
    priceRange,
    // 이 훅은 `/api/range` 를 **따로** 부르므로 차트 파이프라인의 환산을 안 지난다.
    // 계수를 넘겨야 요청 밴드를 원주가로 되돌리고 응답을 다시 환산한다 — 안 넘기면
    // 호버 컷오프 프로파일만 옛 척도로 남는다(`scaleRangeBundlePrices` 참조).
    adjustFactors: linked ? link.adjustFactors : undefined,
    liveTrades: cutoffTrades,
    candles: activeCandles,
    segment: cutoffSegment,
  });
  const closePoints = useMemo(
    () => (activeDate ? volumeDistributionClosePointsFromCandles(activeCandles) : []),
    [activeCandles, activeDate],
  );
  if (!linked) return <LinkPendingCard kind={win.kind} group={win.group} />;
  return (
    <div className="flex h-full flex-col bg-bg-card">
      <div className="min-h-0 flex-1 overflow-auto">
      <VolumeDistributionCard
        profile={cutoffProfile}
        cursorMs={spotCursorMs}
        closePoints={closePoints}
        color={vdistSettings.color}
        maxColor={vdistSettings.maxColor}
        axisProfile={activeProfile}
      />
      </div>
    </div>
  );
}

function ProgramWindow({ win, code }: { win: WorkspaceWindow; code: string }) {
  const link = useGroupChartLink(win.group);
  const programView = useProgramTradeDisplayStore((s) => s.view);
  const cursorDate = useGroupCursorDate(win.group);
  const { cursorMs, timeframe: cursorTimeframe } = useGroupCursor(win.group, programView !== 'daily');
  const scope = resolveCursorDetailScope({ cursorMs, timeframe: cursorTimeframe });
  const linked = link !== null && link.code === code;
  const dailyTo = link?.todayKst ?? '';
  const dailyFrom = dailyTo ? subtractDaysKst(dailyTo, 130) : '';
  const dailyProgram = useLiveDailyProgramTrade(
    programView === 'daily' ? code : null,
    programView === 'daily' ? dailyFrom : null,
    programView === 'daily' ? dailyTo : null,
  );
  const dailyHistory = useDailyProgramTradeHistory(
    programView === 'daily' && linked ? code : null,
    programView === 'daily' && linked ? dailyFrom : null,
  );
  const dailyPoints = useMemo(() => {
    const byTime = new Map<number, import('../../api/liveDailyProgramTrade').DailyProgramTradePoint>();
    for (const page of dailyHistory.data?.pages ?? []) {
      for (const point of page.points) byTime.set(point.t_ms, point);
    }
    for (const point of dailyProgram.data?.points ?? []) byTime.set(point.t_ms, point);
    return [...byTime.values()];
  }, [dailyHistory.data, dailyProgram.data?.points]);
  // program(0w) WS 실시간 꼬리 — `live.program` 도 선택 venue 로 걸러져 온다
  // (liveSeries.ts 의 filterByVenueTag). 백엔드의 KRX-only 발행 강제는 ADR-0140 §2 에서
  // 걷혔고, 지금은 세 venue 모두 venue 태그를 달고 publish 된다. 5분 주기 번들의 program_trade
  // (REST 본체)에 이 꼬리를 이어 거래원·10호가와 같은 즉시성으로 갱신한다 — 예전엔
  // 번들만 봐서 최대 5분 지연됐다.
  const venue = useLiveVenueStore((s) => s.venue);
  const live = useLiveSeries(code, venue);
  const liveTail = useMemo(() => aggregateProgramTrade(live.program), [live.program]);
  const series = useMemo(
    () => link?.program?.series ?? mergeProgramTradeWithLiveTail(link?.bundle?.program_trade ?? null, liveTail),
    [link?.program?.series, link?.bundle?.program_trade, liveTail],
  );
  // Price and program history share real timestamps but load independently.
  // The card clips both to the selected day and draws whichever is ready.
  const closePoints = useMemo(
    () => volumeDistributionClosePointsFromCandles(link?.bundle?.candles ?? []),
    [link?.bundle?.candles],
  );
  if (!linked) return <LinkPendingCard kind={win.kind} group={win.group} />;
  return (
    <div className="flex h-full flex-col bg-bg-card">
      <div className="min-h-0 flex-1 overflow-auto">
      <ProgramTradeSummaryCard
        key={code}
        series={series}
        programState={link.program?.state}
        closeState={link.program?.closeState}
        cursorMs={scope.kind === 'minute-cursor' ? scope.cursorMs : null}
        cursorDate={cursorDate}
        closePoints={closePoints}
        // 거래원식 오늘 스코프 — 마지막 점이 오늘이 아니면(새날 아침) 전일 마감
        // 누적을 현재값처럼 보여주지 않고 빈 상태로 리셋한다.
        todayKst={link.todayKst}
        dailyPoints={dailyPoints}
        dailyLoading={dailyProgram.isLoading}
        dailyError={Boolean(dailyProgram.error)}
        dailyHasOlder={dailyHistory.data === undefined || Boolean(dailyHistory.hasNextPage)}
        dailyLoadingOlder={dailyHistory.isFetching}
        dailyOlderError={dailyHistory.isError}
        onLoadOlder={() => { void dailyHistory.fetchNextPage(); }}
      />
      </div>
    </div>
  );
}

// 번들 세그먼트(snake_case) → sessionTime.isClosingAuction 입력형(camelCase).
// VolumeDistributionCard 의 동일 사상과 같은 어댑터 — 도메인 판정은 단일 소스
// (sessionTime)를 재사용해 axis 와 동치 유지(virtualAxis.inClosingAuctionWindow 위임 대상).
function toSessionSegments(segments: readonly RangeSegment[]): SessionSegment[] {
  return segments.map((s) => ({ sessionOpenMs: s.session_open_ms, sessionCloseMs: s.session_close_ms }));
}

// KST 표기 — 사이드바 카드들(TradeTickTable 등)과 동일하게 toLocaleTimeString.
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
