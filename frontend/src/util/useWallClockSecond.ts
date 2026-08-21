import { useEffect, useState } from 'react';

/** 초 경계 직후로 틱을 미는 여유(ms).
 *
 * 0 이면 타이머가 경계 **직전**(예: 999.6ms)에 깨어날 때 `Date.now()` 가 아직 이전
 * 초라서 같은 초를 두 번 그리고, 다음 재무장이 0.4ms 뒤로 잡혀 틱이 두 배로 늘어난다.
 * 20ms 는 표시 지연으로 눈에 띄지 않으면서(사람의 동시성 인지 한계 ~100ms) 타이머
 * 반올림·스케줄 지터를 흡수하는 크기다. */
const BOUNDARY_EPSILON_MS = 20;

/**
 * 지금(`nowMs`)에서 **다음 초 경계 직후**까지 남은 ms.
 *
 * `setInterval(1000)` 이 못 하는 일이 이것이다: 인터벌은 **마운트 시점의 위상을
 * 영원히 유지**한다. 900ms 지점에서 시작하면 표시는 매초 900ms 씩 늦게 바뀌고,
 * 지터가 누적되면 위상이 더 밀려 결국 한 초를 건너뛰거나 두 번 그린다. 매 틱마다
 * 경계까지의 거리를 **다시 계산**하면 위상 오차가 누적될 자리가 없다 — 늦게 깨어난
 * 만큼 다음 대기가 짧아져 스스로 되돌아온다.
 */
export function nextSecondBoundaryDelayMs(nowMs: number): number {
  return 1000 - (nowMs % 1000) + BOUNDARY_EPSILON_MS;
}

/**
 * 벽시계 초 — 초가 바뀔 때마다 호출자를 리렌더하는 `Date.now()`.
 *
 * **매 틱 `Date.now()` 를 다시 읽는다**(누적 카운터도, `performance.now()` 도 아니다).
 * 그래야 OS 의 NTP 보정과 절전/복귀 점프를 그대로 상속한다 — "정확한 시계" 의 반대말은
 * 보통 틀린 시계가 아니라 **자기 힘으로 시간을 세는 시계**다.
 *
 * 두 가지를 더 한다:
 * - **초 경계 정렬**(`nextSecondBoundaryDelayMs`) — 표시가 벽시계와 같은 순간에 바뀐다.
 * - **가시성 복귀 재동기화** — Chrome 은 숨겨진 탭의 타이머를 분당 1회까지 조인다.
 *   그대로 두면 탭으로 돌아왔을 때 라벨이 최대 1분 낡은 값에 멈춰 있다. bfcache 복귀
 *   (`pageshow`)도 같은 구멍이라 함께 받는다.
 *
 * 1초마다 리렌더하므로 **리프 컴포넌트에서만 호출한다**. 상위(예: TopNav)에서 부르면
 * 형제 전체가 — 입력 중인 검색창까지 — 매초 리렌더된다.
 *
 * 30초 주기 나이 표시 등 경계 정렬이 필요 없는 곳은 그대로 `useNowMs` 를 쓴다.
 */
export function useWallClockSecond(): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    let timer = 0;

    const tick = () => {
      const now = Date.now();
      setNowMs(now);
      timer = window.setTimeout(tick, nextSecondBoundaryDelayMs(now));
    };
    tick();

    // 숨겨진 동안(스로틀 구간)에는 재무장해 봐야 어차피 안 돈다 — 보이는 순간에만
    // 즉시 한 번 그리고 위상을 다시 잡는다.
    const resync = () => {
      if (document.hidden) return;
      window.clearTimeout(timer);
      tick();
    };
    document.addEventListener('visibilitychange', resync);
    window.addEventListener('pageshow', resync);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', resync);
      window.removeEventListener('pageshow', resync);
    };
  }, []);

  return nowMs;
}
