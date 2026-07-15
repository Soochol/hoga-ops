import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { isMinuteTimeframe, useLivePageStore } from '../state/livePage';
import { useLiveStatus } from '../api/liveStatus';
import { useLiveStatusProjection } from './liveStatusProjection';
import { LiveStatusBar } from './LiveStatusBar';
import { LiveWorkarea } from './LiveWorkarea';
import { LiveStateBanner } from './LiveStateBanner';
import { activateLiveCode, activateLiveInstrument } from './liveNavigate';
import { focusLiveSearch } from './liveSearchFocus';
import { useLiveKeyboard } from './useLiveKeyboard';
import { useLiveBundle } from './useLiveBundle';
import { useLiveSeries } from '../api/liveSeries';
import { useDayAskPeaks, useTodayAllPriceAskPeak } from './useDayAskPeaks';
import { useDayBidPeaks, useTodayAllPriceBidPeak } from './useDayBidPeaks';
import { useTradeVolumePocs } from './useTradeVolumePoc';
import type { AskPeak, BidPeak, Candle, RangeBundle, TradeVolumePocWire } from '../api/types';
import type { ObSnapshot, TradeSnapshot } from './bucketHogaSeries';
import type { TabViewport } from './viewportAnchor';
import { initialHistoricalDaysFor, subtractDaysKst, todayKstYyyymmdd } from './liveDateTime';
import { useLiveVenueStore } from '../state/liveVenue';
import { freshLiveTradePrice } from './deriveCurrentPriceLine';
import {
  clearCurrentStudySaveSource,
  setCurrentStudySaveSource,
  type LiveStudySaveSource,
} from '../studyViews/studySaveSource';
import { LiveStudyViewSaveButton } from '../studyViews/LiveStudyViewSaveButton';
import IndicatorPanel from './indicators/IndicatorPanel';
import { panePrefsForTimeframe, type PanePrefsIndicatorSource } from './indicators/indicatorPaneProfiles';
import { useDailyMaRevealGate } from './indicators/useDailyMaRevealGate';
import LiveSettingsModal from './LiveSettingsModal';
import { useDocumentTitle } from '../util/useDocumentTitle';
import { indexInstrument, instrumentLabel, isLiveIndexId } from './liveInstrument';
import { useLiveIndexCandles, useLiveIndexInvestorNet } from '../api/liveIndices';
import { buildIndexBundle } from './buildIndexBundle';
import { capabilitiesForInstrument } from './liveInstrumentCapabilities';

/** 안정 빈 배열 — 매 렌더 새 [] 가 useDayAskPeaks의 메모 deps를 churn하지 않게. */
const EMPTY_ASK_PEAKS: readonly AskPeak[] = [];
const EMPTY_BID_PEAKS: readonly BidPeak[] = [];
const EMPTY_CANDLES: readonly Candle[] = [];
const EMPTY_OB_SNAPSHOTS: readonly ObSnapshot[] = [];
const EMPTY_TRADE_SNAPSHOTS: readonly TradeSnapshot[] = [];

const INDEX_BUCKET_MS = {
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '10m': 600_000,
  '15m': 900_000,
  '30m': 1_800_000,
  D: 86_400_000,
  W: 7 * 86_400_000,
  M: 31 * 86_400_000,
} as const;

function tradeVolumePocsToWire(pocs: readonly {
  date: string;
  centerPrice: number;
  lowPrice: number;
  highPrice: number;
  qty: number;
  t_ms: number;
  bandPct: number;
}[]): TradeVolumePocWire[] {
  return pocs.map((poc) => ({
    date: poc.date,
    center_price: poc.centerPrice,
    low_price: poc.lowPrice,
    high_price: poc.highPrice,
    qty: poc.qty,
    t_ms: poc.t_ms,
    band_pct: poc.bandPct,
  }));
}

/**
 * /live page — KIS-based real-time indicator chart.
 *
 * Three-row grid (symbol search lives in the global TopNav header line):
 *   1. LiveStateBanner (auto)                  — empty/error state matrix
 *   2. LiveStatusBar   (var(--h-pricestrip))   — code/price/source/timeframe + cycle_lag pill
 *   3. LiveWorkarea    (1fr)                   — chart panel (toolbar + chart) + detail panel
 *
 * Active code resolution (CONTEXT.md / ADR-0052 / ADR-0113):
 *   useLivePageStore is the single source of truth that all read sites consume
 *   for activeCode, and `projectActiveView` is its single WRITER (tabs removed —
 *   single-view model). `?code=`/`?index=` is a one-shot deep-link SEED on first
 *   mount; with neither, the restored activeInstrument (live.page.v1) is
 *   normalized to a fresh view (pan reset). Search / ♥ / Watchlist / Heatmap /
 *   Screener clicks write the active view in place via liveNavigate; with no
 *   restored subject, LiveWorkarea shows the empty state.
 */
export function LivePage() {
  const [params] = useSearchParams();
  const queryCode = params.get('code');
  const queryIndex = params.get('index');

  // 1회 시드: URL ?code=/?index= 딥링크는 그 종목으로 현재 뷰를 연다. 없으면
  // live.page.v1에서 복원된 활성 종목의 pan/뷰포트를 초기화해 fresh view로 정규화한다
  // (탭 제거 후 단일 뷰 복귀, ADR-0113 — 새로고침=마지막 종목·타임프레임 유지, pan 리셋).
  // 복원된 종목이 없으면 빈 상태(종목 검색 안내)를 보인다.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    if (queryCode) { activateLiveCode(queryCode); return; }
    if (isLiveIndexId(queryIndex)) { activateLiveInstrument(indexInstrument(queryIndex, queryIndex)); return; }
    const restored = useLivePageStore.getState().activeInstrument;
    if (restored) activateLiveInstrument(restored);
  }, [queryCode, queryIndex]);

  const { data: status } = useLiveStatus();
  const liveStatus = useLiveStatusProjection(status);
  const banner = liveStatus.banner;

  const activeCode = useLivePageStore((s) => s.activeCode);
  const activeInstrument = useLivePageStore((s) => s.activeInstrument);
  const timeframe = useLivePageStore((s) => s.candleTimeframe);
  const historicalFromDate = useLivePageStore((s) => s.historicalFromDate);
  const liveVenue = useLiveVenueStore((s) => s.venue);
  const paneIndicators = useLivePageStore((s): PanePrefsIndicatorSource => ({
    volumeEnabled: s.volumeEnabled,
    quoteTotalsEnabled: s.quoteTotalsEnabled,
    ratioEnabled: s.ratioEnabled,
    fillStrengthEnabled: s.fillStrengthEnabled,
    programTradeEnabled: s.programTradeEnabled,
    foreignNetEnabled: s.foreignNetEnabled,
    institutionNetEnabled: s.institutionNetEnabled,
    panePrefsByTimeframe: s.panePrefsByTimeframe,
  }));
  const activePanePrefs = useMemo(
    () => panePrefsForTimeframe(paneIndicators, timeframe),
    [paneIndicators, timeframe],
  );
  const investorNetEnabled = activePanePrefs.foreignNetEnabled || activePanePrefs.institutionNetEnabled;
  useDocumentTitle(activeCode);
  const [indicatorPanelOpen, setIndicatorPanelOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 저장뷰(Study View Save)가 현재 차트 뷰포트를 캡처하는 데 쓰는 ref — 탭이 아니라
  // 뷰포트 프리미티브다(ADR-0113: 탭별 뷰포트 저장은 제거, 저장뷰 캡처는 유지).
  const viewportCaptureRef = useRef<() => TabViewport | null>(() => null);
  const handleViewportCaptureReady = useCallback((capture: () => TabViewport | null) => {
    viewportCaptureRef.current = capture;
  }, []);

  // Keyboard shortcuts (Addendum 9.y / Design B7).
  // j/k traversal callbacks will be supplied by Stage 11 when the watchlist
  // panel is wired up; for now they're no-ops. Shift+숫자 = 타임프레임 슬롯.
  useLiveKeyboard({
    onSelectTimeframeShortcut: (slot) => {
      const page = useLivePageStore.getState();
      const next = slot === 'minute' ? page.lastMinuteTimeframe : slot;
      page.setCandleTimeframe(next);
    },
  });

  // Single live source for the page: useLiveSeries owns the SSE connection
  // and ring buffer; useLiveBundle composes it with KIS past-candles for the
  // chart; LiveSidebar reads ob/broker from the same buffer for LATEST mode.
  // Two independent useLiveSeries calls would open two SSE connections and
  // two buffers — HMR re-mounts cleared one but not the other, leaving the
  // sidebar's LATEST mode stuck on the empty-buffer state.
  const today = todayKstYyyymmdd();
  const live = useLiveSeries(activeCode ?? '');
  const { bundle, chartBundle, hogaBundle, clampEngaged, isPastCandlesLoading, isHogaLoading, isExtending, isSidecarLoading, pastDataWarnings, hogaCoverageGapDates, indicatorCoverageFromDate, rangeWindowFromDate } = useLiveBundle(
    activeCode,
    timeframe,
    today,
    live,
    { investorNetEnabled, venue: liveVenue },
  );
  const liveInitial = live.initial?.code === activeCode ? live.initial : undefined;
  const stockBundle = activeCode && bundle?.code === activeCode ? bundle : null;
  const stockChartBundle = activeCode && chartBundle?.code === activeCode ? chartBundle : null;
  const stockHogaBundle = activeCode && hogaBundle?.code === activeCode ? hogaBundle : null;
  const activeIndexId = activeInstrument?.kind === 'index' ? activeInstrument.id : null;
  // 일봉 MA 오버레이 초기 fetch도 reveal 게이트에 편입(개선안 1-B) — 오버레이와 동일
  // 쿼리키라 react-query가 공유(네트워크 중복 없음). isSidecarLoading에 OR해 같은 캡으로 묶는다.
  const isDailyMaLoading = useDailyMaRevealGate({ code: activeCode, timeframe, venue: liveVenue, todayKst: today });
  const capabilities = useMemo(() => capabilitiesForInstrument(activeInstrument), [activeInstrument]);
  const indexFrom = historicalFromDate ?? subtractDaysKst(today, initialHistoricalDaysFor(timeframe));
  const indexCandles = useLiveIndexCandles(
    activeIndexId,
    timeframe,
    indexFrom,
    today,
  );
  const indexInvestorFrom = indexCandles.data?.from ?? indexFrom;
  const indexInvestorTo = indexCandles.data?.to ?? today;
  const indexInvestorNet = useLiveIndexInvestorNet(
    activeIndexId && timeframe === 'D' && capabilities.investorNet === 'market' ? activeIndexId : null,
    indexInvestorFrom,
    indexInvestorTo,
    timeframe === 'D' && capabilities.investorNet === 'market' && investorNetEnabled,
  );
  const indexBundle = useMemo<RangeBundle | null>(() => {
    if (!activeIndexId || !indexCandles.data) return null;
    return buildIndexBundle({
      indexId: activeIndexId,
      from: indexCandles.data.from,
      to: indexCandles.data.to,
      bucketMs: INDEX_BUCKET_MS[timeframe],
      candles: indexCandles.data.candles,
      investorPoints: indexInvestorNet.data?.points ?? [],
    });
  }, [activeIndexId, timeframe, indexCandles.data, indexInvestorNet.data?.points]);
  const activeLabel = activeInstrument ? instrumentLabel(activeInstrument) : activeCode;
  // 상태바 현재가용 fresh 체결가 — 타임프레임 무관(live.trade 는 code 단위 구독).
  // D/W/M 에서도 라인/상태바가 실시간 체결을 반영하게 하는 하드닝. LiveChartRoot 도
  // 같은 순수함수를 별도 계산하지만 값이 동일해 "라인=상태바" invariant 를 유지한다.
  const liveTradePrice = freshLiveTradePrice(live.trade, liveVenue, Date.now());
  const askPeakOb = isMinuteTimeframe(timeframe) ? live.ob : EMPTY_OB_SNAPSHOTS;
  const askPeakTrade = isMinuteTimeframe(timeframe) ? live.trade : EMPTY_TRADE_SNAPSHOTS;
  const askPeakSeeds = (stockChartBundle ?? stockBundle)?.ask_peaks ?? EMPTY_ASK_PEAKS;
  const askPeakCandles = isMinuteTimeframe(timeframe) ? ((stockChartBundle ?? stockBundle)?.candles ?? EMPTY_CANDLES) : EMPTY_CANDLES;
  const dayAskPeaks = useDayAskPeaks(
    askPeakOb,
    askPeakTrade,
    askPeakSeeds,
    today,
    activeCode,
    liveInitial?.ask_peak_today ?? null,
    askPeakCandles,
  );
  const todayAllPriceAskPeak = useTodayAllPriceAskPeak(
    askPeakOb,
    askPeakSeeds,
    today,
    activeCode,
    liveInitial?.ask_peak_today ?? null,
  );
  const bidPeakOb = isMinuteTimeframe(timeframe) ? live.ob : EMPTY_OB_SNAPSHOTS;
  const bidPeakTrade = isMinuteTimeframe(timeframe) ? live.trade : EMPTY_TRADE_SNAPSHOTS;
  const bidPeakSeeds = (stockChartBundle ?? stockBundle)?.bid_peaks ?? EMPTY_BID_PEAKS;
  const bidPeakCandles = isMinuteTimeframe(timeframe) ? ((stockChartBundle ?? stockBundle)?.candles ?? EMPTY_CANDLES) : EMPTY_CANDLES;
  const dayBidPeaks = useDayBidPeaks(
    bidPeakOb,
    bidPeakTrade,
    bidPeakSeeds,
    today,
    activeCode,
    liveInitial?.bid_peak_today ?? null,
    bidPeakCandles,
  );
  const todayAllPriceBidPeak = useTodayAllPriceBidPeak(
    bidPeakOb,
    bidPeakSeeds,
    today,
    activeCode,
    liveInitial?.bid_peak_today ?? null,
  );
  const tradeVolumePocs = useTradeVolumePocs(
    isMinuteTimeframe(timeframe) ? live.trade : EMPTY_TRADE_SNAPSHOTS,
    (stockChartBundle ?? stockBundle)?.trade_volume_pocs ?? [],
    today,
    activeCode,
    isMinuteTimeframe(timeframe) ? ((stockChartBundle ?? stockBundle)?.candles ?? EMPTY_CANDLES) : EMPTY_CANDLES,
    isMinuteTimeframe(timeframe) ? ((stockChartBundle ?? stockBundle)?.segments ?? []) : [],
    isMinuteTimeframe(timeframe) ? live.ob : EMPTY_OB_SNAPSHOTS,
  );
  const liveSaveBundle = useMemo<RangeBundle | null>(() => {
    if (!stockBundle) return null;
    const base = stockChartBundle ?? stockBundle;
    return {
      ...stockBundle,
      from_date: base.from_date,
      to_date: base.to_date,
      bucket_ms: base.bucket_ms,
      segments: base.segments,
      candles: base.candles,
      volume_profile_range: base.volume_profile_range,
      volume_profile_by_day: base.volume_profile_by_day,
      volume_distributions: base.volume_distributions ?? [],
      investorPoints: base.investorPoints,
      ask_peaks: dayAskPeaks,
      bid_peaks: dayBidPeaks,
      broker_late_entries: base.broker_late_entries ?? [],
      trade_volume_pocs: tradeVolumePocsToWire(tradeVolumePocs),
      depth_heatmap: base.depth_heatmap ?? [],
    };
  }, [stockBundle, stockChartBundle, dayAskPeaks, dayBidPeaks, tradeVolumePocs]);
  const workareaCode = activeCode ?? (activeIndexId ? `index:${activeIndexId}` : null);
  const workareaBundle = activeIndexId ? indexBundle : stockBundle;
  const workareaChartBundle = activeIndexId ? indexBundle : stockChartBundle;
  const workareaHogaBundle = activeIndexId ? indexBundle : stockHogaBundle;
  const workareaLoading = activeIndexId ? indexCandles.isLoading : isPastCandlesLoading;
  const indexExtending = activeIndexId ? historicalFromDate !== null && indexCandles.isFetching : false;
  const workareaDataWarnings = activeIndexId ? indexCandles.data?.data_warnings ?? [] : pastDataWarnings;

  useEffect(() => {
    if (!activeCode || !liveSaveBundle) {
      setCurrentStudySaveSource(null);
      return undefined;
    }
    const source: LiveStudySaveSource = {
      origin: 'live',
      code: activeCode,
      label: activeLabel || activeCode,
      timeframe,
      bundle: liveSaveBundle,
      captureViewport: () => viewportCaptureRef.current(),
    };
    setCurrentStudySaveSource(source);
    return () => {
      clearCurrentStudySaveSource(source);
    };
  }, [activeCode, activeLabel, liveSaveBundle, timeframe]);

  return (
    <div
      className="h-full grid"
      style={{
        // minmax(0, 1fr) on the workarea row prevents the chart canvas's
        // intrinsic size from pushing the row past viewport height.
        gridTemplateRows:
          'auto var(--h-pricestrip) minmax(0, 1fr)',
      }}
    >
      <LiveStateBanner
        primary={workareaCode && banner.primary === 'watchlist_empty' ? null : banner.primary}
        stack={banner.stack}
      />
      <LiveStatusBar
        activeCode={workareaCode}
        captureHealth={liveStatus.captureHealth}
        bundle={workareaBundle}
        venue={liveVenue}
        hogaGapDates={hogaCoverageGapDates}
        liveTradePrice={liveTradePrice}
        isExtending={activeIndexId ? indexExtending : isExtending}
      />
      <LiveWorkarea
        activeCode={workareaCode}
        activeInstrument={activeInstrument}
        bundle={workareaBundle}
        chartBundle={workareaChartBundle}
        hogaBundle={workareaHogaBundle}
        clampEngaged={clampEngaged}
        isPastCandlesLoading={workareaLoading}
        isHogaLoading={activeIndexId ? false : isHogaLoading}
        isSidecarLoading={activeIndexId ? false : (isSidecarLoading || isDailyMaLoading)}
        isExtending={activeIndexId ? indexExtending : isExtending}
        indicatorCoverageFromDate={activeIndexId ? null : indicatorCoverageFromDate}
        rangeWindowFromDate={activeIndexId ? null : rangeWindowFromDate}
        pastDataWarnings={workareaDataWarnings}
        restoreViewport={null}
        viewIdentity={workareaCode ? `${workareaCode}:${liveVenue}` : liveVenue}
        venue={liveVenue}
        live={live}
        dayAskPeaks={dayAskPeaks}
        todayAllPriceAskPeak={todayAllPriceAskPeak}
        todayAskPeakInput={liveInitial?.ask_peak_today ?? null}
        dayBidPeaks={dayBidPeaks}
        todayAllPriceBidPeak={todayAllPriceBidPeak}
        todayBidPeakInput={liveInitial?.bid_peak_today ?? null}
        todayKst={today}
        tradeVolumePocs={tradeVolumePocs}
        onOpenIndicators={() => setIndicatorPanelOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenSearch={focusLiveSearch}
        studySaveControl={<LiveStudyViewSaveButton />}
        onViewportCaptureReady={handleViewportCaptureReady}
        paneTogglesOverride={{
          hogaPanes: capabilities.hogaPanes,
        }}
      />
      {indicatorPanelOpen && (
        <IndicatorPanel
          onClose={() => setIndicatorPanelOpen(false)}
          capabilities={capabilities}
          timeframe={timeframe}
        />
      )}
      {settingsOpen && (
        <LiveSettingsModal onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  );
}

export default LivePage;
