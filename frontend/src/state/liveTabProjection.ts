import type { LiveTimeframe } from './livePage';
import type { LiveTab } from './liveTabs';

export type ActiveViewProjection = {
  code: string | null;
  timeframe: LiveTimeframe;
  historicalFromDate: string | null;
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
    code: tab?.code ?? null,
    timeframe: tab?.timeframe ?? currentPageTimeframe,
    historicalFromDate: tab?.historicalFromDate ?? null,
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

  return tabs.map((t) =>
    t.id === activeTabId
      ? {
          ...t,
          timeframe: page.candleTimeframe,
          historicalFromDate: page.historicalFromDate,
          ...(userChangedTimeframe ? { viewport: null } : {}),
        }
      : t,
  );
}
