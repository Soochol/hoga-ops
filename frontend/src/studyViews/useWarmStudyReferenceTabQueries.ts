import { useStudyChartIndicators } from './useStudyChartIndicators';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { StudyViewReference } from '../api/studyViews';
import type { StudyTab } from '../state/studyTabs';
import { useOrderflowSourcePref } from '../state/sourcePreference';
import { referenceStudyView } from './studyViewVariant';
import { studyReferenceQueryOptions } from './studyReferenceQueries';
import { studyDailyContextWindow } from './studyDailyContext';
import { STUDY_VENUE } from './studyVenuePolicy';

export type StudyTabQueryStatus = 'idle' | 'loading' | 'ready' | 'error';

type WarmQuerySpec = {
  tabId: string;
  /** 이 spec 이 실제로 fetch 를 낼 수 있는가. false 면 관찰만 하고 요청은 안 나간다. */
  open: boolean;
  query: ReturnType<typeof studyReferenceQueryOptions>[keyof ReturnType<typeof studyReferenceQueryOptions>];
};

/**
 * 한 번에 워밍을 새로 여는 비활성 탭 수.
 *
 * **1인 이유는 백엔드가 사실상 직렬이기 때문이다.** `/api/range` 는 조용할 때
 * 단독 0.63초인데, 32코어에서 스레드 6개로 동시에 돌려도 wall 이 5.9배로 늘어난다
 * (행→pydantic 변환이 GIL 을 놓지 않는다). 즉 동시에 던진 요청은 서로를 그 수만큼
 * 늦출 뿐 총 처리량을 늘리지 못한다. 실측 최대 22개 동시 in-flight 에서 요청 하나가
 * 8~213초까지 늘어났고, 그 대부분이 이 훅이 활성화된 탭 전부에 4쿼리씩 한꺼번에
 * 발사한 것이었다.
 *
 * 워밍은 배경 작업이라 늦어도 손해가 없다 — 사용자가 그 탭을 실제로 누르면 그 탭이
 * 활성이 되어 곧바로 우선순위를 받는다.
 */
const WARM_INACTIVE_TAB_CONCURRENCY = 1;

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
  // 워밍 쿼리도 활성 경로와 **같은 venue** 여야 한다 — 다르면 탭 전환 시 캐시가 안 맞아
  // 재fetch 된다. `/study` 가 KRX 고정(`studyVenuePolicy`, ADR-0144)이 되면서 그 제약이
  // 자명하게 충족된다: 양쪽 모두 같은 상수를 읽는다.
  //
  // 여기 있던 코드별 `useEffectiveVenueResolver` 는 **탭마다 종목이 달라서** 필요했다
  // (활성 탭 기준 venue 를 다른 종목의 워밍에 물리면 캐시 키가 어긋나 재fetch 를
  // 막으려던 것이 재fetch 를 만든다, #1216). 상수에는 그 위험이 없다.

  const warmTabIds = useMemo(() => {
    const ids = new Set(activatedTabIds);
    if (activeTabId) ids.add(activeTabId);
    return ids;
  }, [activeTabId, activatedTabIds]);

  // 실제로 요청을 낼 수 있는 탭들. 워밍 후보(`warmTabIds`) 전부가 아니라 **여기 있는
  // 것만** 발사한다 — 상수 주석 참조.
  //
  // ⚠ **렌더 중에 갱신한다**(effect 가 아니라). effect 는 커밋 뒤라 한 발 늦는데,
  // 그 사이 활성이던 탭이 비활성으로 바뀌면 spec 이 `useQueries` 배열에서 빠지고
  // react-query 가 관찰자를 해제하며 **진행 중이던 요청을 abort** 한다. 탭 전환이
  // 직전 탭의 in-flight 를 죽이지 않는다는 계약이 이 훅의 테스트에 못 박혀 있다.
  // 렌더 중 ref mutation 이지만 멱등한 grow-only 라 StrictMode 이중 렌더에도 안전하다.
  const openedRef = useRef<Set<string>>(new Set());
  // 슬롯 전진(아래 effect)이 `openedRef` 를 바꿨을 때 spec 을 다시 만들게 하는 신호.
  // ref 는 deps 로 쓸 수 없어 버전 카운터를 대신 둔다.
  const [openedVersion, setOpenedVersion] = useState(0);

  // 한 번 활성이었던 탭은 계속 열어 둔다(위 abort 계약).
  if (activeTabId) openedRef.current.add(activeTabId);
  // 닫힌 탭은 집합에서 지운다 — 안 지우면 같은 id 가 재사용될 때 워밍 순서를 건너뛴다.
  for (const id of openedRef.current) {
    if (!warmTabIds.has(id)) openedRef.current.delete(id);
  }

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
      const settings = { ...baseSettings, venue: STUDY_VENUE };
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
      // 옵션 레벨 `enabled`(설정 로딩 중 등)를 먼저 거르고, 그 위에 워밍 게이트를
      // **곱한다**. 아직 순번이 안 온 탭도 spec 자체는 만들어 둔다 — 관찰자가 있어야
      // 상태 맵이 'idle'(한 번도 활성화 안 됨)과 'loading'(워밍 대기·진행)을 구분한다.
      const open = openedRef.current.has(tab.id);
      return [options.rangeHoga, options.rangeSidecars, options.rangeCandles, options.screenerDaily]
        .filter((query) => query.enabled)
        .map((query) => ({
          tabId: tab.id,
          open,
          query: open ? query : { ...query, enabled: false },
        }));
    });
  }, [
    openedVersion,
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

  // 슬롯 전진: 지금 열려 있는 것들이 전부 끝나면 다음 탭을 연다.
  //
  // "끝났다" 는 성공만이 아니라 **에러로 끝난 것도 포함**한다(재시도까지 소진한
  // 쿼리는 isPending·isFetching 이 모두 false 다). 안 그러면 실패한 탭 하나가 뒤의
  // 워밍을 영구히 막는다. save 가 없어 spec 이 0개인 탭도 자동으로 끝난 것이 된다.
  //
  // 활성 탭이 영영 안 끝나면 비활성 워밍은 시작되지 않는다 — **의도한 동작이다.**
  // 워밍의 목적은 배경 선반입이지 활성 화면과 대역폭을 다투는 것이 아니다.
  useEffect(() => {
    const openPending = specs.some((spec, index) => {
      if (!spec.open) return false;
      const result = results[index];
      return !result || result.isPending || result.isFetching;
    });
    if (openPending) return;

    const next = tabs
      .filter((tab) => warmTabIds.has(tab.id) && !openedRef.current.has(tab.id))
      .slice(0, WARM_INACTIVE_TAB_CONCURRENCY);
    if (next.length === 0) return;
    for (const tab of next) openedRef.current.add(tab.id);
    setOpenedVersion((v) => v + 1);
  }, [results, specs, tabs, warmTabIds]);

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
