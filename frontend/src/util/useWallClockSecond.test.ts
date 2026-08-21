import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { nextSecondBoundaryDelayMs, useWallClockSecond } from './useWallClockSecond';

/** 초 경계에서 900ms 어긋난 시각 — `setInterval` 이 위상을 영원히 유지한다는 사실이
 *  드러나는 지점이다. 경계에서 시작하면 정렬 유무가 구별되지 않아 테스트가 무신호가 된다. */
const OFF_BOUNDARY = Date.parse('2026-08-21T05:03:30.900Z');

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
}

describe('nextSecondBoundaryDelayMs', () => {
  it.each([
    [0, 1020],      // 경계 정각 — 다음 경계까지 온전히 1초
    [900, 120],     // 900ms 지점 — 남은 100ms + 여유 20
    [999, 21],      // 경계 직전
    [1, 1019],      // 경계 직후
  ])('%dms 지점에서 %dms 뒤 재무장', (offset, expected) => {
    expect(nextSecondBoundaryDelayMs(OFF_BOUNDARY - (OFF_BOUNDARY % 1000) + offset)).toBe(expected);
  });

  it('늦게 깨어난 만큼 다음 대기가 짧아진다 — 위상 오차가 누적될 자리가 없다', () => {
    // 200ms 늦게 발화 → 다음 대기는 800+20 이라 경계로 되돌아온다. 인터벌은 이 자리에서
    // 1000 을 그대로 더해 200ms 지연을 영구히 물려받는다.
    expect(nextSecondBoundaryDelayMs(2_000 + 200)).toBe(820);
  });
});

describe('useWallClockSecond', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(OFF_BOUNDARY);
    setHidden(false);
  });
  afterEach(() => {
    vi.useRealTimers();
    setHidden(false);
  });

  it('마운트 직후엔 현재 시각을 그대로 준다', () => {
    const { result } = renderHook(() => useWallClockSecond());
    expect(result.current).toBe(OFF_BOUNDARY);
  });

  it('틱이 초 경계 직후에 발화한다 — 900ms 늦게 바뀌지 않는다', () => {
    // red-check: 경계 정렬을 빼고 setInterval(1000) 로 되돌리면 매 틱 % 1000 이 900 으로
    // 고정돼 이 단언이 깨진다(= 라벨이 벽시계보다 0.9초 늦게 바뀐다).
    const { result } = renderHook(() => useWallClockSecond());
    const offsets: number[] = [];
    for (let i = 0; i < 5; i++) {
      act(() => vi.advanceTimersByTime(1000));
      offsets.push(result.current % 1000);
    }
    expect(offsets).toEqual([20, 20, 20, 20, 20]);
  });

  it('초를 건너뛰거나 두 번 그리지 않는다', () => {
    const { result } = renderHook(() => useWallClockSecond());
    const seconds = [new Date(result.current).getUTCSeconds()];
    for (let i = 0; i < 5; i++) {
      act(() => vi.advanceTimersByTime(1000));
      seconds.push(new Date(result.current).getUTCSeconds());
    }
    expect(seconds).toEqual([30, 31, 32, 33, 34, 35]);
  });

  it('탭 복귀 시 즉시 재동기화한다 — 타이머를 기다리지 않는다', () => {
    // 숨겨진 탭에서 Chrome 은 타이머를 분당 1회까지 조인다. 시계만 65초 밀고(타이머는
    // 그대로) 복귀 이벤트를 쏴서 그 구멍을 재현한다.
    const { result } = renderHook(() => useWallClockSecond());
    const woke = OFF_BOUNDARY + 65_000;
    vi.setSystemTime(woke);
    expect(result.current).toBe(OFF_BOUNDARY); // 아직 낡은 값
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(result.current).toBe(woke);
  });

  it('bfcache 복귀(pageshow)도 같은 구멍이라 함께 받는다', () => {
    const { result } = renderHook(() => useWallClockSecond());
    const woke = OFF_BOUNDARY + 65_000;
    vi.setSystemTime(woke);
    act(() => {
      window.dispatchEvent(new Event('pageshow'));
    });
    expect(result.current).toBe(woke);
  });

  it('숨겨지는 방향의 visibilitychange 에는 아무 일도 하지 않는다', () => {
    // 양방향 red-check: 위 테스트만 있으면 `document.hidden` 가드를 지워도 초록이다.
    const { result } = renderHook(() => useWallClockSecond());
    setHidden(true);
    vi.setSystemTime(OFF_BOUNDARY + 65_000);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(result.current).toBe(OFF_BOUNDARY);
  });

  it('언마운트 후엔 타이머도 리스너도 남지 않는다', () => {
    const { unmount } = renderHook(() => useWallClockSecond());
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    // 리스너가 남아 있으면 여기서 재무장이 일어나 타이머가 되살아난다.
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pageshow'));
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
