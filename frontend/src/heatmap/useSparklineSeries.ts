import { useSparklineStore } from '../state/sparklineStore';

/** 코드→since-open 시계열 Map(읽기 전용 뷰). 폴마다 새 Map 참조라 소비자가
 *  재렌더되지만 폴 주기=10초라 비용 무해(spec §Risks). */
export function useSparklineSeries(): Map<string, number[]> {
  return useSparklineStore((s) => s.series);
}
