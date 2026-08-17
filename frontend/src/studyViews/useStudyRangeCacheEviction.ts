import { useEffect, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { bucketMsFromRangeKey } from '../api/range';
import { TIMEFRAME_TO_MS, type Timeframe } from '../api/types';
import type { LiveTimeframe } from '../state/livePage';

/**
 * 활성 저장뷰의 종목이 아닌 `['range', code, ...]` 캐시를 즉시 축출한다.
 *
 * range 번들은 저장뷰 하나에 수십 MB(JSON 기준 ~23MB, 파싱 후 힙에서 그 몇 배)이고
 * `staleTime: Infinity` + 기본 `gcTime` 30분이라, 저장뷰를 옮겨 다니면 이전 종목의
 * 번들이 30분씩 힙에 상주한다. 장시간 세션에서 힙이 GB 단위로 부풀어 GC 정지가
 * 길어지고 마우스/크로스헤어가 버벅이는 원인이다.
 *
 * **ADR-0148 로 보존 대상이 좁아졌다.** 종전엔 "열린 탭 어느 하나라도 든 종목" 을
 * 남겼지만 `/study` 는 이제 저장뷰를 하나만 연다 — 보존 집합이 활성 종목 하나다.
 * 그만큼 **축출이 공격적**이어서 뷰 A↔B 왕복은 매번 재fetch 가 된다. 메모리와
 * 재요청을 맞바꾼 것이고, 체감이 나쁘면 "직전 종목 1개 유예" 가 다음 수다.
 *
 * **봉 축도 함께 본다(#801)** — 차트 창이 여러 개면 같은 종목 아래 봉별 번들이 쌓인다.
 * 종목만 보는 규칙은 그걸 영원히 남기므로, 활성 종목에 한해 "열린 창 어디에도 없는 봉"
 * 을 추가로 지운다. 창이 하나뿐이던 시절에도 봉을 여러 번 바꾸면 같은 일이 벌어졌으니
 * 이건 멀티 창이 만든 문제가 아니라 드러낸 문제다.
 *
 * `type: 'inactive'` 가드 필수: 축출 시점에 아직 옵저버가 남아 있는 쿼리를 지우면
 * RQ가 즉시 재생성·재요청한다. 옵저버가 남은 채 활성에서 빠진 종목은 다음 활성 뷰
 * 변경 때 자연히 축출된다(자가 치유). 열린 창들은 `useStudyReferenceBundles` 의
 * `useQueries` 로 옵저버를 들고 있으므로 이 가드 하나로 "지금 쓰는 번들" 은 보호된다.
 */
export function useStudyRangeCacheEviction(
  /** 활성 저장뷰의 종목. `null` 이면 보존 집합이 비어 관찰자 없는 range 캐시를 전부 지운다. */
  activeCode: string | null = null,
  /** 지금 열려 있는 차트 창들의 봉. */
  openTimeframes: readonly LiveTimeframe[] = [],
): void {
  const queryClient = useQueryClient();
  // 봉은 **버킷 ms** 로 비교한다 — 쿼리 키에 있는 것이 그 값이다.
  const keepBucketsKey = useMemo(() => {
    const buckets = new Set<number>();
    for (const tf of openTimeframes) {
      const ms = TIMEFRAME_TO_MS[tf as Timeframe];
      if (typeof ms === 'number') buckets.add(ms);
      // 캘린더 봉(D/W/M)은 `TIMEFRAME_TO_MS` 에 없다 — **`['range', …]` 캐시를 아예
      // 쓰지 않기 때문이다**(#1277 이후 D/W/M 은 스크리너 일봉만 본다). 그러니 이 봉이
      // 버킷 축에 기여할 것은 원래 없다.
      //
      // 그런데 아무것도 안 더하면 **캘린더 창만 열려 있을 때 그 종목의 분봉 캐시가
      // 통째로 축출된다.** 봉을 분봉으로 되돌리는 순간 전부 재fetch 이고, 그게 이
      // 축출 훅이 줄이려던 바로 그 비용이다. 축출은 되돌릴 수 없으니 보존 쪽으로
      // 남긴다 — 1m 을 넣어 두면 최소 한 벌은 살아남는다.
      //
      // (여기 있던 "캘린더 봉은 1분봉을 받아 프론트에서 집계한다" 는 근거는 #1277 에
      // 폐기됐다. 값은 같고 이유가 바뀌었다.)
      else buckets.add(TIMEFRAME_TO_MS['1m']);
    }
    return [...buckets].sort((a, b) => a - b).join(',');
  }, [openTimeframes]);

  useEffect(() => {
    const keepBuckets = new Set(keepBucketsKey.split(',').filter(Boolean).map(Number));
    queryClient.removeQueries({
      queryKey: ['range'],
      type: 'inactive',
      predicate: (query) => {
        const code = query.queryKey[1];
        if (typeof code !== 'string') return false;
        // 보존 집합은 활성 종목 하나다(ADR-0148). 나머지는 전부 축출 대상.
        if (code !== activeCode) return true;
        // 열린 창 봉을 하나도 모르면 **봉 축을 끈다** — 빈 배열은 "보존할 봉이 없다" 가
        // 아니라 "창이 아직 없다"(하이드레이션 직전)는 뜻이다. 여기서 축출하면 창이
        // 뜨자마자 전부 재fetch 다. 탭이 있던 시절엔 탭 봉이 이 자리를 메워서 이 구멍이
        // 드러나지 않았다(ADR-0148 로 그 안전망이 사라졌다).
        if (keepBuckets.size === 0) return false;
        const bucketMs = bucketMsFromRangeKey(query.queryKey);
        // 판별 불가 → 보존. 축출은 되돌릴 수 없다.
        return bucketMs !== null && !keepBuckets.has(bucketMs);
      },
    });
  }, [activeCode, keepBucketsKey, queryClient]);
}
