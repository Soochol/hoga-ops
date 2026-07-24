import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import { apiCall } from './client';
import type { LiveVenueOption } from '../state/liveVenue';

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

/**
 * 그룹 당일 흐름을 60초 폴링해 folder_id → 등락률 시계열(%) Map 으로 준다.
 * null 버킷(무데이터)은 제거해 실측 점만 시간순으로 남긴다 — 미니 스파크라인은
 * 균등 간격으로 충분하고, GroupFlowSparkline 이 <2점을 빈 상태로 처리한다.
 */
export function useHeatmapGroupFlow(venue: LiveVenueOption = 'KRX'): Map<string, number[]> {
  const { data } = useQuery({
    queryKey: ['heatmap-group-flow', venue] as const,
    queryFn: () => getHeatmapGroupFlow(venue),
    refetchInterval: 60_000,
    staleTime: 60_000,
  });
  return useMemo(() => {
    const map = new Map<string, number[]>();
    for (const g of data?.groups ?? []) {
      map.set(g.folder_id, g.pct.filter((v): v is number => v !== null));
    }
    return map;
  }, [data]);
}
