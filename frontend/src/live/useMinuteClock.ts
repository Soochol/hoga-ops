/**
 * 1분 해상도 시계 — **리렌더 유발원이 사라지는 구간**을 위한 최소 틱.
 *
 * 장중에는 없어도 맞는다. WS·폴링이 리렌더를 계속 만들기 때문이다. 문제는 그 유발원이
 * 멎는 구간이다: 18:00 에 시간외 폴링이 끊기면 그 뒤로 리렌더가 없어 **시계에 기대는
 * 표시가 밤새 얼어붙는다.** 얼어붙은 표시는 이 리포가 반복해서 다뤄 온 실패 유형이라
 * 1분 틱 하나로 닫는다(경계 오차 최대 60초).
 *
 * ## 반환값은 **1분으로 절삭된** ms 다
 *
 * `Date.now()` 를 그대로 주면 매 렌더 새 값이라, 이걸 deps 에 넣은 `useMemo` 가 전부
 * 무효화된다 — 시계를 참조하는 것만으로 메모이제이션이 죽는다. 절삭하면 1분에 한 번만
 * 바뀌므로 소비처 memo 가 안정적이고, 같은 분에 다시 찍힌 틱은 `setState` 가 스스로
 * no-op 이라 리렌더도 나지 않는다.
 *
 * ⚠ **시각 판정의 근거로만 쓸 것.** 최대 60초 낡은 값이므로 경과 시간 표시나 프레임
 * 나이 계산처럼 초 단위가 의미를 갖는 곳에 넣으면 안 된다. 그런 곳은 이미 자기
 * 리렌더 유발원(WS·폴링)을 갖고 있다.
 */
import { useEffect, useState } from 'react';

const MINUTE_MS = 60_000;

export function useMinuteClock(): number {
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / MINUTE_MS));
  useEffect(() => {
    const id = setInterval(() => setMinute(Math.floor(Date.now() / MINUTE_MS)), MINUTE_MS);
    return () => clearInterval(id);
  }, []);
  return minute * MINUTE_MS;
}
