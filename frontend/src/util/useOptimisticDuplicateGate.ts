import { useCallback, useRef, useState } from 'react';

/**
 * 낙관 캐시 위에서 「이미 있음」을 판정하는 폼의 공용 규율.
 *
 * **문제**: 관심종목·히트맵의 추가 mutation 은 둘 다 낙관적이라 요청을 보내는 **그 순간**
 * 캐시에 행을 넣는다. 중복 판정을 그 캐시에서 매 렌더 파생하면, 응답을 기다리는 동안
 * 판정이 뒤집혀 폼이 **자기가 방금 넣은 행**을 보고 자신을 고발한다("추가했는데 중복이라고
 * 한다"). 느린 네트워크일수록 오래 보인다.
 *
 * **처방**: 제출이 도는 동안 판정을 얼린다. 두 가지가 이 훅 안에 함께 있어야 한다 —
 *
 *  1. `duplicate` 는 `submitting` 이 아닐 때만 참이다.
 *  2. `submitting` 은 `fn` 이 **끝난 뒤에** 내려간다. mutation 의 `isPending` 으로 대신할 수
 *     없다: React Query 가 먼저 pending 을 내리고 폼의 `setPicked(null)` 이 그 뒤에 돌아,
 *     그 틈에 렌더가 끼면 배너가 한 프레임 번쩍인다. `fn` 안에 그 정리까지 넣으면 두 갱신이
 *     한 배치에서 커밋된다.
 *
 * ⚠ **호출부는 선택 초기화를 `fn` 안에 둬야 한다.** `await run(...)` 뒤에 두면 위 (2) 가
 * 무너져 결함이 그대로 돌아온다.
 *
 * 얼리는 대가로 「중복이라 재진입이 막힌다」가 사라지므로, `run` 이 이중 실행도 막는다.
 */
export function useOptimisticDuplicateGate<T>(
  picked: T | null,
  isDuplicate: (picked: T) => boolean,
) {
  const [submitting, setSubmitting] = useState(false);
  const duplicate = !submitting && picked !== null && isDuplicate(picked);

  // 재진입 판정은 **ref 로** 한다 — state 를 읽으면 같은 렌더에서 두 번 들어온 제출이
  // 둘 다 `false` 를 보고 통과한다(리렌더 사이에만 막힌다). 연타가 실경로인 표면이라
  // (두 번째 Enter 가 곧 제출) 그 창을 열어 둘 이유가 없다. 이 ref 덕에 `run` 은
  // 의존이 없어 참조가 안정적이기도 하다.
  const running = useRef(false);
  const run = useCallback(async (fn: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setSubmitting(true);
    try {
      await fn();
    } catch {
      /* 에러 표면은 호출부가 소유한다(mutation.error 배너 등) */
    } finally {
      running.current = false;
      setSubmitting(false);
    }
  }, []);

  return { duplicate, submitting, run };
}
