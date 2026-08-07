/** 시장 종합 API 클라이언트 — 폴링 게이트 계약을 고정한다.
 *
 * 폴링 주기 자체는 벽시계로 재지 않는다(리포 규율) — **게이트가 언제 열리고 닫히는가**
 * 만 순수 함수로 검증한다.
 *
 * 여기에 **부활 경로** 가드가 함께 있다. `isMarketHours` 만 검증하던 때 이 파일은
 * 초록이었지만, 장외에 연 탭이 09:00 이 지나도 영영 안 깨어나는 버그를 놓쳤다
 * (2026-08-07) — 순수 함수는 옳았고 그 값을 **누가 언제 다시 묻는가**가 틀렸기 때문이다. */
// `waitFor` 는 쓰지 않는다 — fake timers 와 섞으면 서로의 타이머를 센다.
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from './client';
import { isMarketHours, useMarketInvestorFlow } from './market';

/** KST 로 해석되는 시각을 만든다 — 러너 TZ 에 의존하지 않기 위해 오프셋을 명시한다. */
function kst(y: number, m: number, d: number, hh: number, mm: number): Date {
  return new Date(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+09:00`);
}

describe('isMarketHours', () => {
  it('정규장 안이면 연다 (09:00–15:30 KST)', () => {
    // 2026-08-05 는 수요일
    expect(isMarketHours(kst(2026, 8, 5, 9, 0))).toBe(true);
    expect(isMarketHours(kst(2026, 8, 5, 12, 0))).toBe(true);
    expect(isMarketHours(kst(2026, 8, 5, 15, 30))).toBe(true);
  });

  it('개장 전·마감 후는 닫는다', () => {
    expect(isMarketHours(kst(2026, 8, 5, 8, 59))).toBe(false);
    expect(isMarketHours(kst(2026, 8, 5, 15, 31))).toBe(false);
    expect(isMarketHours(kst(2026, 8, 5, 23, 0))).toBe(false);
  });

  it('주말은 장중 시각이어도 닫는다', () => {
    // 2026-08-08 토 · 08-09 일
    expect(isMarketHours(kst(2026, 8, 8, 11, 0))).toBe(false);
    expect(isMarketHours(kst(2026, 8, 9, 11, 0))).toBe(false);
  });

  it('휴장일은 거르지 않는다 — 프론트는 달력을 모른다', () => {
    // 게이트의 한계를 명시적으로 고정한다: 평일 공휴일에는 열린다(백엔드가
    // 빈 응답을 주고 last-good 이 유지되므로 화면은 깨지지 않는다).
    expect(isMarketHours(kst(2026, 8, 17, 11, 0))).toBe(true);
  });
});

describe('장외 하트비트 — 게이트가 스스로 깨어난다', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function wrapper({ children }: { children: ReactNode }) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return createElement(QueryClientProvider, { client: qc }, children);
  }

  /** 장외에 마운트한 탭이 09:00 이후 **리렌더 없이** 폴링을 재개하는가.
   *
   *  이게 실패하면 전날부터 켜 둔 탭이 아침에 영영 안 살아난다. 함수형
   *  `refetchInterval` 이 `false` 를 반환하면 타이머가 사라지고, 타이머가 없으면
   *  fetch 도 재평가도 없어 자기를 되살릴 수 없기 때문이다(2026-08-07 실측:
   *  장외 마운트 후 장중으로 시각을 돌려도 150초간 fetch 0회). 수급 카드는
   *  게이트 쿼리가 단독이라 리렌더로 구제될 여지도 없다. */
  it('장외에 마운트해도 장이 열리면 리렌더 없이 다시 받아온다', async () => {
    vi.setSystemTime(kst(2026, 8, 7, 8, 0)); // 개장 전
    const spy = vi
      .spyOn(client, 'apiCall')
      .mockResolvedValue({ markets: {}, coverage: {}, daily: [] } as never);

    renderHook(() => useMarketInvestorFlow(), { wrapper });
    await vi.advanceTimersByTimeAsync(0);
    expect(spy).toHaveBeenCalledTimes(1); // 마운트 1회

    vi.setSystemTime(kst(2026, 8, 7, 9, 5)); // 장이 열렸다 — 아무도 리렌더하지 않는다
    await vi.advanceTimersByTimeAsync(60_000); // 하트비트 1주기

    expect(spy.mock.calls.length).toBeGreaterThan(1);
  });

  it('장외 내내 있어도 타이머가 살아 있다', async () => {
    vi.setSystemTime(kst(2026, 8, 7, 20, 0)); // 마감 후
    const spy = vi
      .spyOn(client, 'apiCall')
      .mockResolvedValue({ markets: {}, coverage: {}, daily: [] } as never);

    renderHook(() => useMarketInvestorFlow(), { wrapper });
    await vi.advanceTimersByTimeAsync(0);
    const afterMount = spy.mock.calls.length;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(spy.mock.calls.length).toBeGreaterThan(afterMount);
  });
});
