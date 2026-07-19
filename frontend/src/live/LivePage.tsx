import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useLivePageStore } from '../state/livePage';
import { useLiveStatus } from '../api/liveStatus';
import { useLiveStatusProjection } from './liveStatusProjection';
import { LiveStatusBar } from './LiveStatusBar';
import { LiveWorkarea } from './LiveWorkarea';
import { LiveStateBanner } from './LiveStateBanner';
import { activateLiveCode, activateLiveInstrument } from './liveNavigate';
import { focusLiveSearch } from './liveSearchFocus';
import { useLiveKeyboard } from './useLiveKeyboard';
import { useWindowView } from './workspace/windowView';
import { useLiveChartData } from './useLiveChartData';
import type { TabViewport } from './viewportAnchor';
import { useLiveVenueStore } from '../state/liveVenue';
import {
  clearCurrentStudySaveSource,
  setCurrentStudySaveSource,
  type LiveStudySaveSource,
} from '../studyViews/studySaveSource';
import { LiveStudyViewSaveButton } from '../studyViews/LiveStudyViewSaveButton';
import IndicatorPanel from './indicators/IndicatorPanel';
import { pickPanePrefs, type PanePrefsIndicatorSource } from './indicators/indicatorPaneProfiles';
import LiveSettingsModal from './LiveSettingsModal';
import { SingleCodeCollectDialog } from '../heatmap/CollectDialog';
import { useSymbols } from '../capture/useSymbols';
import { useDocumentTitle } from '../util/useDocumentTitle';
import { indexInstrument, isLiveIndexId } from './liveInstrument';


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

  // 창-스코프 뷰(ADR-0119 PR-B) — Provider 밖에서는 전역 스토어로 폴백하므로 기능
  // 무변경. PR-C 가 창별 Provider 를 붙이면 이 페이지 서브트리가 창의 값을 본다.
  const { code: activeCode, timeframe, historicalFromDate } = useWindowView();
  const activeInstrument = useLivePageStore((s) => s.activeInstrument);
  const liveVenue = useLiveVenueStore((s) => s.venue);
  const paneIndicators = useLivePageStore((s): PanePrefsIndicatorSource => ({
    volumeEnabled: s.volumeEnabled,
    quoteTotalsEnabled: s.quoteTotalsEnabled,
    ratioEnabled: s.ratioEnabled,
    fillStrengthEnabled: s.fillStrengthEnabled,
    programTradeEnabled: s.programTradeEnabled,
    foreignNetEnabled: s.foreignNetEnabled,
    institutionNetEnabled: s.institutionNetEnabled,
  }));
  // /live 의 ambient 지표 봉 동기화 — 세터 경로가 이미 투영하지만, /study 에서
  // 돌아온 마운트 시점의 재동기화는 이 effect 가 책임진다(PR-A #699).
  const setIndicatorTimeframe = useLivePageStore((s) => s.setIndicatorTimeframe);
  useEffect(() => {
    setIndicatorTimeframe(timeframe);
  }, [setIndicatorTimeframe, timeframe]);
  const activePanePrefs = useMemo(
    () => pickPanePrefs(paneIndicators),
    [paneIndicators],
  );
  const investorNetEnabled = activePanePrefs.foreignNetEnabled || activePanePrefs.institutionNetEnabled;
  useDocumentTitle(activeCode);
  const [indicatorPanelOpen, setIndicatorPanelOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 활성 종목 지난 N일 hogaplay 수집(히트맵 CollectDialog 재사용) — 주식 종목 한정.
  const [collectOpen, setCollectOpen] = useState(false);
  // 활성 종목이 사라지면(지수 전환 등) 열림 플래그도 정리 — 다음 주식 선택 때
  // 다이얼로그가 사용자 액션 없이 재등장하지 않게.
  useEffect(() => {
    if (!activeCode) setCollectOpen(false);
  }, [activeCode]);
  // 딥링크(?code=) 시드는 instrument label=code 라, 수집 다이얼로그 제목은 상태바와
  // 동일 소스(심볼 마스터)에서 실명을 보강한다. 미해석이면 label(=검색 경유 시 실명)로.
  const { data: symbolsData } = useSymbols();
  const collectSymbolName = useMemo(
    () => (activeCode ? symbolsData?.symbols.find((s) => s.code === activeCode)?.name : undefined),
    [symbolsData, activeCode],
  );
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

  // 차트 데이터 파이프라인(useLiveSeries+useLiveBundle+지수+peaks+POC+저장번들+workarea
  // 파생)은 useLiveChartData 훅으로 추출(ADR-0119 PR-C2a) — LivePage 는 활성 뷰로 호출해
  // 기능 무변경, ChartWindow(C2b)가 창별로 재사용한다. 단일 useLiveSeries 불변식(SSE 1개·
  // 링버퍼 1개; 두 개면 HMR 재마운트가 한쪽만 비워 LATEST 모드가 빈 버퍼에 갇힘)은 훅 내부로.
  const {
    today,
    live,
    liveInitial,
    liveTradePrice,
    activeIndexId,
    activeLabel,
    capabilities,
    clampEngaged,
    isHogaLoading,
    isSidecarLoading,
    isExtending,
    indexExtending,
    isDailyMaLoading,
    indicatorCoverageFromDate,
    rangeWindowFromDate,
    hogaCoverageGapDates,
    dayAskPeaks,
    todayAllPriceAskPeak,
    dayBidPeaks,
    todayAllPriceBidPeak,
    tradeVolumePocs,
    liveSaveBundle,
    workareaCode,
    workareaBundle,
    workareaChartBundle,
    workareaHogaBundle,
    workareaLoading,
    workareaDataWarnings,
  } = useLiveChartData({
    activeCode,
    activeInstrument,
    timeframe,
    historicalFromDate,
    venue: liveVenue,
    investorNetEnabled,
  });

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
        onOpenCollect={activeCode ? () => setCollectOpen(true) : undefined}
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
      {collectOpen && activeCode && (
        <SingleCodeCollectDialog
          // 다이얼로그가 열린 채 종목이 바뀌면 remount 로 미리보기·기간 상태를 초기화한다.
          key={activeCode}
          code={activeCode}
          name={collectSymbolName ?? activeLabel ?? activeCode}
          onClose={() => setCollectOpen(false)}
        />
      )}
    </div>
  );
}

export default LivePage;
