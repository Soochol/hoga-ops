import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import { apiCall } from './client';
import type { LiveVenueOption } from '../state/liveVenue';
import { HEATMAP_GROUP_FLOW_KEY } from '../heatmap/heatmapKeys';

/** 한 그룹(폴더)의 당일 흐름 = 버킷별 멤버 평균 등락률(%). 무데이터 버킷은 null. */
export interface HeatmapGroupFlowGroup {
  folder_id: string;
  pct: (number | null)[];
}

/** 전 그룹 공유 시간축(t_base_ms + bucket_ms) + 그룹별 pct 배열. 컴팩트 페이로드. */
export interface HeatmapGroupFlowResponse {
  /** 거래일(KST, YYYY-MM-DD). */
  date: string;
  /** 버킷 폭(ms). 예: 300000(5분). */
  bucket_ms: number;
  /** 첫 버킷 시작 unix ms(정규장 개장). */
  t_base_ms: number;
  groups: HeatmapGroupFlowGroup[];
}

export function getHeatmapGroupFlow(venue: LiveVenueOption = 'KRX'): Promise<HeatmapGroupFlowResponse> {
  return apiCall<HeatmapGroupFlowResponse>(`/api/heatmap/group-flow?venue=${venue}`);
}

/** 비교 화면은 null과 시간축을 보존한 원본을 사용한다. 미니 그래프와 쿼리 공유. */
export function useHeatmapGroupFlowData(venue: LiveVenueOption = 'KRX') {
  return useQuery({
    queryKey: [...HEATMAP_GROUP_FLOW_KEY, venue] as const,
    queryFn: () => getHeatmapGroupFlow(venue),
    refetchInterval: 60_000,
    staleTime: 60_000,
  });
}

export function groupFlowSparklines(data: HeatmapGroupFlowResponse | undefined): Map<string, number[]> {
  return new Map((data?.groups ?? []).map((g) => [
    g.folder_id, g.pct.filter((v): v is number => v !== null && Number.isFinite(v)),
  ]));
}

/**
 * 그룹 당일 흐름을 60초 폴링해 folder_id → 등락률 시계열(%) Map 으로 준다.
 * null 버킷(무데이터)은 제거해 실측 점만 시간순으로 남긴다 — 미니 스파크라인은
 * 균등 간격으로 충분하고, GroupFlowSparkline 이 <2점을 빈 상태로 처리한다.
 */
export function useHeatmapGroupFlow(venue: LiveVenueOption = 'KRX'): Map<string, number[]> {
  const { data } = useHeatmapGroupFlowData(venue);
  return useMemo(() => groupFlowSparklines(data), [data]);
}
