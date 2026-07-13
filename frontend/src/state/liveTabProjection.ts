import type { LiveTimeframe } from './livePage';
import type { LiveTab } from './liveTabs';
import { stockInstrument, type LiveInstrument } from '../live/liveInstrument';
import type { TabViewport } from '../live/viewportAnchor';

export type ActiveViewProjection = {
  instrument: LiveInstrument | null;
  code: string | null;
  timeframe: LiveTimeframe;
  historicalFromDate: string | null;
  /** 탭이 들고 있는 분봉 창 기억(런타임). 투영 시 페이지의
   *  lastMinuteHistoricalFromDate를 이 값으로 재시드 — D/W/M 상태로 탭을
   *  오가도 분봉 복귀 복원이 살아남는다. */
  lastMinuteHistoricalFromDate: string | null;
  viewport: TabViewport | null;
};

export type PageViewMirror = {
  candleTimeframe: LiveTimeframe;
  historicalFromDate: string | null;
  lastMinuteHistoricalFromDate: string | null;
};

export function projectTabToActiveView(
  tab: LiveTab | null,
  currentPageTimeframe: LiveTimeframe,
): ActiveViewProjection {
  return {
    instrument: tab?.instrument ?? (tab?.code ? stockInstrument(tab.code, tab.label) : null),
    code: tab?.code ?? null,
    timeframe: tab?.timeframe ?? currentPageTimeframe,
    historicalFromDate: tab?.historicalFromDate ?? null,
    lastMinuteHistoricalFromDate: tab?.lastMinuteHistoricalFromDate ?? null,
    viewport: tab?.viewport ?? null,
  };
}

export function mirrorPageViewToActiveTab(
  tabs: LiveTab[],
  activeTabId: string | null,
  page: PageViewMirror,
): LiveTab[] {
  if (!activeTabId) return tabs;
  const activeTab = tabs.find((t) => t.id === activeTabId);
  if (!activeTab) return tabs;
  const userChangedTimeframe = page.candleTimeframe !== activeTab.timeframe;
  const userChangedPan = page.historicalFromDate !== activeTab.historicalFromDate;
  const minuteWindowChanged =
    page.lastMinuteHistoricalFromDate !== (activeTab.lastMinuteHistoricalFromDate ?? null);
  if (!userChangedTimeframe && !userChangedPan && !minuteWindowChanged) return tabs;

  return tabs.map((t) =>
    t.id === activeTabId
      ? {
          ...t,
          timeframe: page.candleTimeframe,
          historicalFromDate: userChangedTimeframe ? null : page.historicalFromDate,
          // 분봉 창 기억은 항상 페이지 값 그대로 — tf 전환 시점의 저장(?? 폴백
          // 포함)을 store가 이미 계산했으므로 미러는 검산하지 않는다.
          lastMinuteHistoricalFromDate: page.lastMinuteHistoricalFromDate,
          viewport: userChangedTimeframe ? null : t.viewport,
        }
      : t,
  );
}
