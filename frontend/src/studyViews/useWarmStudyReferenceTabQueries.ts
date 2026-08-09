import { useStudyChartIndicators } from './useStudyChartIndicators';
import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { StudyViewReference } from '../api/studyViews';
import type { StudyTab } from '../state/studyTabs';
import { useOrderflowSourcePref } from '../state/sourcePreference';
import { referenceStudyView } from './studyViewVariant';
import { studyReferenceQueryOptions } from './studyReferenceQueries';
import { studyDailyContextWindow } from './studyDailyContext';
import { useLiveVenueStore } from '../state/liveVenue';
import { useEffectiveVenueResolver } from '../live/useEffectiveVenue';

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
  const sourcePref = useOrderflowSourcePref();
  // 지표는 차트 창이 소유한다(#904) — 전역을 읽으면 차트가 그릴 지표와 여기서
  // 받아오는 데이터가 어긋난다.
  const {
    brokerLateEntryEnabled,
    brokerLateEntryStartHHMM,
    tradeVolumePocEnabled,
    depthHeatmapEnabled,
    volumeDistributionEnabled,
    volumeDistributionRangeCount,
  } = useStudyChartIndicators();
  // 워밍 쿼리도 같은 venue 여야 한다 — 다르면 탭 전환 시 캐시가 안 맞아 재fetch 된다.
  //
  // **탭마다 종목이 다르므로 코드별 resolver 가 필요하다.** 단일 값으로 해석하면
  // (useStudyReferenceBundle 처럼) 활성 탭 기준 venue 를 다른 종목의 워밍에 물려
  // 캐시 키가 어긋난다 — 재fetch 를 막으려던 것이 정확히 재fetch 를 만든다.
  // resolver 는 `useCallback` 이라 identity 가 안정적이라 deps 에 그대로 넣는다.
  const selectedVenue = useLiveVenueStore((s) => s.venue);
  const resolveVenue = useEffectiveVenueResolver(selectedVenue);

  const warmTabIds = useMemo(() => {
    const ids = new Set(activatedTabIds);
    if (activeTabId) ids.add(activeTabId);
    return ids;
  }, [activeTabId, activatedTabIds]);

  const specs = useMemo<WarmQuerySpec[]>(() => {
    const savesById = new Map(saves.map((save) => [save.id, save]));
    const baseSettings = {
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
      // venue 는 **탭의 종목으로** 해석한다 — 활성 탭 것을 물리면 안 된다.
      const settings = { ...baseSettings, venue: resolveVenue(save.code) };
      // tab.timeframe이 SSOT: viewTimeframes는 effect로 한 커밋 늦게 동기화돼,
      // "열 때 기본 시간봉" override로 연 첫 렌더에서 save.timeframe으로 워밍
      // 쿼리를 만들면 즉시 버려질 range 번들을 한 벌 더 fetch하게 된다.
      const timeframe = tab.timeframe;
      const displayed = { ...save, timeframe };
      // 맥락 창도 활성 경로와 **같은 규칙으로** 계산한다 — 안 넘기면 캘린더 봉 탭의
      // screenerDaily 키가 갈려 워밍이 헛돌고 활성 전환에서 다시 fetch 한다.
      const options = studyReferenceQueryOptions(
        displayed,
        settings,
        studyDailyContextWindow(displayed),
      );
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
    volumeDistributionRangeCount, resolveVenue,
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
