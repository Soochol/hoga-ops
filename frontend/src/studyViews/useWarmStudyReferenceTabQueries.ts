import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { StudyViewReference } from '../api/studyViews';
import { useLivePageStore, type LiveTimeframe } from '../state/livePage';
import type { StudyTab } from '../state/studyTabs';
import { useLiveVenueStore } from '../state/liveVenue';
import { useSourcePreferenceStore } from '../state/sourcePreference';
import { referenceStudyView } from './studyViewVariant';
import { studyReferenceQueryOptions } from './studyReferenceQueries';

export type StudyTabQueryStatus = 'idle' | 'loading' | 'ready' | 'error';

type WarmQuerySpec = {
  tabId: string;
  query: ReturnType<typeof studyReferenceQueryOptions>[keyof ReturnType<typeof studyReferenceQueryOptions>];
};

type UseWarmStudyReferenceTabQueriesArgs = {
  tabs: StudyTab[];
  activeTabId: string | null;
  activatedTabIds: readonly string[];
  saves: StudyViewReference[];
  viewTimeframes: Record<string, LiveTimeframe>;
};

export function useWarmStudyReferenceTabQueries({
  tabs,
  activeTabId,
  activatedTabIds,
  saves,
  viewTimeframes,
}: UseWarmStudyReferenceTabQueriesArgs): Record<string, StudyTabQueryStatus> {
  const venue = useLiveVenueStore((s) => s.venue);
  const sourcePref = useSourcePreferenceStore((s) => s.sourcePreference);
  const tradeVolumePocEnabled = useLivePageStore((s) => s.tradeVolumePocEnabled);
  const volumeDistributionEnabled = useLivePageStore((s) => s.volumeDistributionEnabled);
  const volumeDistributionRangeCount = useLivePageStore((s) => s.volumeDistributionRangeCount);

  const warmTabIds = useMemo(() => {
    const ids = new Set(activatedTabIds);
    if (activeTabId) ids.add(activeTabId);
    return ids;
  }, [activeTabId, activatedTabIds]);

  const specs = useMemo<WarmQuerySpec[]>(() => {
    const savesById = new Map(saves.map((save) => [save.id, save]));
    const settings = {
      venue,
      sourcePref,
      tradeVolumePocEnabled,
      volumeDistributionEnabled,
      volumeDistributionRangeCount,
    };
    return tabs.flatMap((tab) => {
      if (!warmTabIds.has(tab.id)) return [];
      const save = referenceStudyView(savesById.get(tab.viewId) ?? null);
      if (!save) return [];
      const timeframe = viewTimeframes[save.id] ?? save.timeframe;
      const options = studyReferenceQueryOptions({ ...save, timeframe }, settings);
      return [options.rangeHoga, options.rangeSidecars, options.minuteCandles, options.dailyCandles]
        .filter((query) => query.enabled)
        .map((query) => ({ tabId: tab.id, query }));
    });
  }, [
    saves,
    sourcePref,
    tabs,
    tradeVolumePocEnabled,
    venue,
    viewTimeframes,
    volumeDistributionEnabled,
    volumeDistributionRangeCount,
    warmTabIds,
  ]);

  const results = useQueries({
    queries: specs.map((spec) => spec.query),
  });

  return useMemo(() => {
    const byTab = new Map<string, typeof results>();
    specs.forEach((spec, index) => {
      const current = byTab.get(spec.tabId) ?? [];
      current.push(results[index]);
      byTab.set(spec.tabId, current);
    });

    const statuses: Record<string, StudyTabQueryStatus> = {};
    for (const tab of tabs) {
      const tabResults = byTab.get(tab.id);
      if (!tabResults || tabResults.length === 0) {
        statuses[tab.id] = 'idle';
      } else if (tabResults.some((result) => result?.isError)) {
        statuses[tab.id] = 'error';
      } else if (tabResults.some((result) => result?.isPending || result?.isLoading || result?.isFetching)) {
        statuses[tab.id] = 'loading';
      } else {
        statuses[tab.id] = 'ready';
      }
    }
    return statuses;
  }, [results, specs, tabs]);
}
