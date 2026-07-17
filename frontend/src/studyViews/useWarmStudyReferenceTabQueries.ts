import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { StudyViewReference } from '../api/studyViews';
import { useLivePageStore } from '../state/livePage';
import type { StudyTab } from '../state/studyTabs';
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
};

export function useWarmStudyReferenceTabQueries({
  tabs,
  activeTabId,
  activatedTabIds,
  saves,
}: UseWarmStudyReferenceTabQueriesArgs): Record<string, StudyTabQueryStatus> {
  const sourcePref = useSourcePreferenceStore((s) => s.sourcePreference);
  const brokerLateEntryEnabled = useLivePageStore((s) => s.brokerLateEntryEnabled);
  const brokerLateEntryStartHHMM = useLivePageStore((s) => s.brokerLateEntryStartHHMM);
  const tradeVolumePocEnabled = useLivePageStore((s) => s.tradeVolumePocEnabled);
  const depthHeatmapEnabled = useLivePageStore((s) => s.depthHeatmapEnabled);
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
      sourcePref,
      brokerLateEntryEnabled,
      brokerLateEntryStartHHMM,
      tradeVolumePocEnabled,
      depthHeatmapEnabled,
      volumeDistributionEnabled,
      volumeDistributionRangeCount,
    };
    return tabs.flatMap((tab) => {
      if (!warmTabIds.has(tab.id)) return [];
      const save = referenceStudyView(savesById.get(tab.viewId) ?? null);
      if (!save) return [];
      // tab.timeframe이 SSOT: viewTimeframes는 effect로 한 커밋 늦게 동기화돼,
      // "열 때 기본 시간봉" override로 연 첫 렌더에서 save.timeframe으로 워밍
      // 쿼리를 만들면 즉시 버려질 range 번들을 한 벌 더 fetch하게 된다.
      const timeframe = tab.timeframe;
      const options = studyReferenceQueryOptions({ ...save, timeframe }, settings);
      return [options.rangeHoga, options.rangeSidecars, options.rangeCandles, options.screenerDaily]
        .filter((query) => query.enabled)
        .map((query) => ({ tabId: tab.id, query }));
    });
  }, [
    saves,
    brokerLateEntryEnabled,
    brokerLateEntryStartHHMM,
    sourcePref,
    tabs,
    tradeVolumePocEnabled,
    depthHeatmapEnabled,
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
