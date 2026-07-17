import { useEffect, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { StudyTab } from '../state/studyTabs';

/**
 * 열린 study 탭 어디에도 없는 종목의 `['range', code, ...]` 캐시를 즉시 축출한다.
 *
 * range 번들은 저장뷰 하나에 수십 MB(JSON 기준 ~23MB, 파싱 후 힙에서 그 몇 배)이고
 * `staleTime: Infinity` + 기본 `gcTime` 30분이라, 저장뷰를 옮겨 다니면 이전 종목의
 * 번들이 30분씩 힙에 상주한다. 장시간 세션에서 힙이 GB 단위로 부풀어 GC 정지가
 * 길어지고 마우스/크로스헤어가 버벅이는 원인이므로, "열린 탭 = 워밍 유지"라는
 * 기존 의미론(useWarmStudyReferenceTabQueries)에 맞춰 탭에서 벗어난 종목만 지운다.
 *
 * `type: 'inactive'` 가드 필수: 축출 시점에 아직 옵저버가 남아 있는 쿼리를 지우면
 * RQ가 즉시 재생성·재요청한다. 옵저버가 남은 채 탭 셋에서 빠진 종목은 다음 탭 셋
 * 변경 때 자연히 축출된다(자가 치유).
 */
export function useStudyRangeCacheEviction(tabs: StudyTab[]): void {
  const queryClient = useQueryClient();
  // 탭 재정렬·핀 고정 등 code 구성이 그대로인 변경에는 축출을 다시 돌리지 않는다.
  const openCodesKey = useMemo(
    () => [...new Set(tabs.map((tab) => tab.code))].sort().join(','),
    [tabs],
  );

  useEffect(() => {
    const keep = new Set(openCodesKey.split(',').filter(Boolean));
    queryClient.removeQueries({
      queryKey: ['range'],
      type: 'inactive',
      predicate: (query) => {
        const code = query.queryKey[1];
        return typeof code === 'string' && !keep.has(code);
      },
    });
  }, [openCodesKey, queryClient]);
}
