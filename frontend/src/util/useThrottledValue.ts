import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * `value` 를 최소 `intervalMs` 간격으로만 통과시킨다(leading + trailing 스로틀).
 * 창 안에 도착한 갱신은 버려지지 않고 모였다가 창이 닫힐 때 **최신값 1회**로 커밋된다.
 * 반환은 `[커밋된 값, flush]` — flush 는 대기 중인 최신값을 **즉시** 커밋하고 거기서
 * 새 창을 연다(아래 참조).
 *
 * 창은 **값이 실제로 바뀔 때 열린다** — 마운트 자체는 창을 열지 않는다. 이 구분이
 * 없으면 마운트 직후 도착하는 첫 실데이터(예: 빈 Map → 시세가 채워진 Map)가 창에
 * 갇혀, 콜드 로드에서 첫 `intervalMs` 동안 정렬이 초기 상태로 보이는 회귀가 난다.
 *
 * flush 도 같은 이유로 **커밋할 것이 있을 때만 창을 연다**. 최신값이 이미 커밋돼 있으면
 * 완전한 no-op 이다 — 여기서 타임스탬프만 찍으면 마운트 직후 이펙트에서 부르는 소비자
 * (정렬 모드 변화에 flush)가 위 콜드 로드 회귀를 그대로 재생산한다.
 *
 * 비교는 `Object.is` — 참조가 바뀌면 창을 연다. 매 갱신이 새 객체인 소비자(시세 Map)
 * 기준으로 보수적인 쪽이다.
 *
 * 용도: 값 자체는 실시간이어야 하지만 그 값으로 정하는 **순서**는 자주 바뀌면 안 되는
 * 경우. 히트맵 정렬이 그 예다 — WS 체결 틱이 150ms 로 코얼레싱돼 초당 최대 ~6.7회
 * 도착하는데(liveTickOverlay.ts LIVE_FLUSH_MS), 그 빈도로 카드가 자리를 바꾸면 읽을 수
 * 없다. 숫자는 계속 살아 움직이고 자리만 이 창으로 정돈된다. flush 는 사용자가 정렬을
 * **지금** 요청한 순간(정렬 버튼 클릭)용이다 — 방금 눌렀는데 낡은 키로 정렬되면 버튼이
 * 고장 나 보인다.
 */
export function useThrottledValue<T>(value: T, intervalMs: number): [T, () => void] {
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

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // 커밋할 것이 없으면 창도 열지 않는다(위 docstring — 마운트 직후 flush 가 no-op
    // 이어야 콜드 로드의 첫 실데이터가 leading 으로 통과한다).
    if (Object.is(latestRef.current, committedRef.current)) return;
    lastCommitMsRef.current = Date.now();
    committedRef.current = latestRef.current;
    setCommitted(latestRef.current);
  }, []);

  return [committed, flush];
}
