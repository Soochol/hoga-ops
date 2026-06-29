import type { LiveTimeframe } from './livePage';
import type { LiveTab } from './liveTabs';
import { stockInstrument, type LiveInstrument } from '../live/liveInstrument';
import type { TabViewport } from '../live/viewportAnchor';

export type ActiveViewProjection = {
  instrument: LiveInstrument | null;
  code: string | null;
  timeframe: LiveTimeframe;
  historicalFromDate: string | null;
  viewport: TabViewport | null;
};

export type PageViewMirror = {
  candleTimeframe: LiveTimeframe;
  historicalFromDate: string | null;
};

export function projectTabToActiveView(
  tab: LiveTab | null,
  currentPageTimeframe: LiveTimeframe,
): ActiveViewProjection {
  return {
    instrument: tab?.instrument ?? (tab?.code ? stockInstrument(tab.code, tab.label) : null),
    code: tab?.code ?? null,
    timeframe: tab?.timeframe ?? currentPageTimeframe,
    historicalFromDate: null,
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
  if (!userChangedTimeframe && !userChangedPan) return tabs;

  return tabs.map((t) =>
    t.id === activeTabId
      ? {
          ...t,
          timeframe: page.candleTimeframe,
          historicalFromDate: userChangedTimeframe ? null : page.historicalFromDate,
          viewport: userChangedTimeframe ? null : t.viewport,
        }
      : t,
  );
}
