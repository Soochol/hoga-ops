import { useEffect, useRef, useState } from 'react';

/**
 * `value` 를 최소 `intervalMs` 간격으로만 통과시킨다(leading + trailing 스로틀).
 * 창 안에 도착한 갱신은 버려지지 않고 모였다가 창이 닫힐 때 **최신값 1회**로 커밋된다.
 *
 * 창은 **값이 실제로 바뀔 때 열린다** — 마운트 자체는 창을 열지 않는다. 이 구분이
 * 없으면 마운트 직후 도착하는 첫 실데이터(예: 빈 Map → 시세가 채워진 Map)가 창에
 * 갇혀, 콜드 로드에서 첫 `intervalMs` 동안 정렬이 초기 상태로 보이는 회귀가 난다.
 *
 * 비교는 `Object.is` — 참조가 바뀌면 창을 연다. 매 갱신이 새 객체인 소비자(시세 Map)
 * 기준으로 보수적인 쪽이다.
 *
 * 용도: 값 자체는 실시간이어야 하지만 그 값으로 정하는 **순서**는 자주 바뀌면 안 되는
 * 경우. 히트맵 정렬이 그 예다 — WS 체결 틱이 150ms 로 코얼레싱돼 초당 최대 ~6.7회
 * 도착하는데(liveTickOverlay.ts LIVE_FLUSH_MS), 그 빈도로 카드가 자리를 바꾸면 읽을 수
 * 없다. 숫자는 계속 살아 움직이고 자리만 이 창으로 정돈된다.
 */
export function useThrottledValue<T>(value: T, intervalMs: number): T {
  const [committed, setCommitted] = useState(value);
  const latestRef = useRef(value);
  const committedRef = useRef(value);
  const lastCommitMsRef = useRef(-Infinity); // 마운트는 커밋이 아니다 → 첫 변화가 leading
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    latestRef.current = value;
    if (Object.is(value, committedRef.current)) return; // 변화 없음 — 창을 열지 않는다
    const commit = () => {
      timerRef.current = null;
      lastCommitMsRef.current = Date.now();
      committedRef.current = latestRef.current;
      setCommitted(latestRef.current);
    };
    const elapsed = Date.now() - lastCommitMsRef.current;
    if (elapsed >= intervalMs) {
      commit();
      return;
    }
    // 창 안 — 이미 예약돼 있으면 그대로 둔다(예약 시각을 미루면 trailing 이 영영 안 온다).
    // 커밋 시점에 latestRef 를 읽으므로 그 사이 갱신은 최신값으로 반영된다.
    if (timerRef.current === null) timerRef.current = setTimeout(commit, intervalMs - elapsed);
  }, [value, intervalMs]);

  // 언마운트 정리는 **마운트 전용** effect 로 둔다 — 위 effect 의 cleanup 에 두면 값이
  // 바뀔 때마다 예약된 trailing 이 취소돼 창이 닫혀도 커밋이 오지 않는다.
  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
  }, []);

  return committed;
}
