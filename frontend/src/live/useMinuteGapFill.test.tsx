import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as client from '../api/client';
import type { LivePastCandlesResponse } from '../api/livePastCandles';
import type { RangeMissingDate } from '../api/types';
import { regularSessionOpenMs } from './liveDateTime';
import { useMinuteGapFill, type UseMinuteGapFillArgs } from './useMinuteGapFill';

/**
 * **막는 방향**: 두 가지다.
 *
 * ① **안 켜져야 할 곳에서 벤더를 두드리는 것.** 게이트가 셋이라(얼림 · 분봉 · KRX)
 *    한 방향만 재면 "항상 통과" 하는 배선도 초록이 된다. 그래서 각 축을 **양방향**으로
 *    잰다 — 켜진 경우의 호출과 꺼진 경우의 침묵을 같은 픽스처에서 본다.
 *
 * ② **요청 폭이 계획을 벗어나는 것.** 계획 함수가 아무리 잘 잘라도 훅이 `to=오늘` 을
 *    보내면 비용은 그대로다. 그래서 단언 대상이 반환값이 아니라 **호출된 URL** 이다.
 *
 * **못 보는 것**: 실제 벤더 walk 의 콜 수와 무자격 환경(503)의 화면. 전자는 백엔드
 * 로그로만 잴 수 있고, 후자는 `retry: false` 덕에 조용히 넘어가는 것이 정상 동작이다.
 */

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

const TODAY = '20260821';

function missing(...dates: string[]): RangeMissingDate[] {
  return dates.map((date) => ({ date, reason: 'not_captured' as const }));
}

/** 그 거래일 09:00 KST 에 봉 하나. 값은 이 테스트에서 의미가 없다. */
function barsFor(date: string) {
  return [{ t_ms: regularSessionOpenMs(date), open: 100, high: 110, low: 90, close: 105, volume: 7 }];
}

/**
 * 요청된 `from`~`to` 안의 날짜를 계수 1로 돌려주는 백엔드 대역.
 * `factors` 로 특정 날짜의 계수를 덮어쓸 수 있다(척도 불일치 재현).
 */
function stubBackend(days: readonly string[], factors: Record<string, number> = {}) {
  return vi.spyOn(client, 'apiCall').mockImplementation(async (url: string) => {
    const params = new URLSearchParams(url.split('?')[1]);
    const from = params.get('from')!;
    const to = params.get('to')!;
    const covered = days.filter((d) => d >= from && d <= to);
    return {
      code: params.get('code')!,
      from,
      to,
      venue: 'KRX',
      bucket_ms: 60_000,
      candles: covered.flatMap(barsFor),
      cached_dates: [],
      fresh_dates: covered,
      data_warnings: [],
      adjust_factors: Object.fromEntries(covered.map((d) => [d, factors[d] ?? 1])),
    } as LivePastCandlesResponse as never;
  });
}

const BASE: UseMinuteGapFillArgs = {
  enabled: true,
  code: '005930',
  venue: 'KRX',
  timeframe: '1m',
  todayKstYyyymmdd: TODAY,
  missingDates: undefined,
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('useMinuteGapFill — 게이트 (양방향)', () => {
  it('얼린 저장뷰면 요청한다', async () => {
    const spy = stubBackend(['20260814']);
    const { result } = renderHook(
      () => useMinuteGapFill({ ...BASE, missingDates: missing('20260814') }),
      { wrapper: wrap(newClient()) },
    );

    await waitFor(() => expect(result.current.filledDates.size).toBe(1));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('얼림이 아니면 침묵한다 — 전역 우회 모드에서 벤더를 두드리지 않는다', async () => {
    const spy = stubBackend(['20260814']);
    const { result } = renderHook(
      () => useMinuteGapFill({ ...BASE, enabled: false, missingDates: missing('20260814') }),
      { wrapper: wrap(newClient()) },
    );

    await waitFor(() => expect(result.current.remainingRuns).toBe(0));
    expect(spy).not.toHaveBeenCalled();
    expect(result.current.filledDates.size).toBe(0);
  });

  it('KRX 가 아니면 침묵한다 — 그 시장 봉을 KRX 로 대신하지 않는다', async () => {
    const spy = stubBackend(['20260814']);
    const { result } = renderHook(
      () => useMinuteGapFill({ ...BASE, venue: 'NXT', missingDates: missing('20260814') }),
      { wrapper: wrap(newClient()) },
    );

    await waitFor(() => expect(result.current.remainingRuns).toBe(0));
    expect(spy).not.toHaveBeenCalled();
  });

  it('캘린더 봉이면 침묵한다 — 분봉 캡처 구멍이 아닌 축이다', async () => {
    const spy = stubBackend(['20260814']);
    renderHook(
      () => useMinuteGapFill({ ...BASE, timeframe: 'D', missingDates: missing('20260814') }),
      { wrapper: wrap(newClient()) },
    );

    await waitFor(() => expect(spy).not.toHaveBeenCalled());
  });
});

describe('useMinuteGapFill — 요청 폭', () => {
  it('요청 구간이 run 경계로 좁혀진다 — 오늘까지 열지 않는다', async () => {
    const spy = stubBackend(['20260401']);
    const { result } = renderHook(
      () => useMinuteGapFill({ ...BASE, missingDates: missing('20260401') }),
      { wrapper: wrap(newClient()) },
    );

    await waitFor(() => expect(result.current.filledDates.size).toBe(1));
    const url = spy.mock.calls[0][0] as string;
    expect(url).toContain('from=20260401');
    expect(url).toContain('to=20260401');
    // `to=오늘` 이면 그 사이 전부가 벤더 pending 이 된다 — 이 기능의 비용 전부가 여기 있다.
    expect(url).not.toContain(`to=${TODAY}`);
  });

  it('떨어진 구멍은 요청을 나눠 순차로 보낸다', async () => {
    const spy = stubBackend(['20260401', '20260801']);
    const { result } = renderHook(
      () => useMinuteGapFill({ ...BASE, missingDates: missing('20260401', '20260801') }),
      { wrapper: wrap(newClient()) },
    );

    await waitFor(() => expect(result.current.filledDates.size).toBe(2));
    expect(spy).toHaveBeenCalledTimes(2);
    // 최신 run 이 먼저다 — 차트가 우측부터 보이므로.
    expect(spy.mock.calls[0][0]).toContain('from=20260801');
    expect(spy.mock.calls[1][0]).toContain('from=20260401');
  });

  it('보유 기간 밖만 있으면 요청조차 하지 않는다', async () => {
    const spy = stubBackend(['20240827']);
    const { result } = renderHook(
      () => useMinuteGapFill({ ...BASE, missingDates: missing('20240827') }),
      { wrapper: wrap(newClient()) },
    );

    await waitFor(() => expect(result.current.unfillableCount).toBe(1));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('useMinuteGapFill — 척도', () => {
  it('계수 ≠ 1 인 날짜는 버리고 이유를 남긴다 — 척도가 다른 봉을 섞지 않는다', async () => {
    const spy = stubBackend(['20260810', '20260811'], { '20260811': 1.9759 });
    const { result } = renderHook(
      () => useMinuteGapFill({ ...BASE, missingDates: missing('20260810', '20260811') }),
      { wrapper: wrap(newClient()) },
    );

    await waitFor(() => expect(result.current.remainingRuns).toBe(0));
    expect(spy).toHaveBeenCalledTimes(1);
    expect([...result.current.filledDates]).toEqual(['20260810']);
    expect(result.current.rescaledDates).toEqual(['20260811']);
    // 버린 날짜의 봉이 시리즈에 새면 차트에 실제와 다른 급등락이 생긴다.
    expect(result.current.candles).toHaveLength(1);
  });

  it('계수를 모르는 날짜도 버린다 — 무척도 봉은 정상처럼 보이는 절벽이 된다', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      code: '005930', from: '20260810', to: '20260810', venue: 'KRX', bucket_ms: 60_000,
      candles: barsFor('20260810'),
      cached_dates: [], fresh_dates: ['20260810'], data_warnings: [],
      adjust_factors: {},
    } as LivePastCandlesResponse as never);
    const { result } = renderHook(
      () => useMinuteGapFill({ ...BASE, missingDates: missing('20260810') }),
      { wrapper: wrap(newClient()) },
    );

    await waitFor(() => expect(result.current.remainingRuns).toBe(0));
    expect(result.current.filledDates.size).toBe(0);
  });
});

describe('useMinuteGapFill — 수확분', () => {
  it('요청하지 않은 날짜는 응답에 실려 와도 버린다 — 디스크를 덮지 않는다', async () => {
    // 벤더 walk 는 커서 프로토콜상 요청 구간 밖의 날짜를 함께 실어 온다. 그 날짜는
    // 디스크에 이미 있을 수 있고, 받아들이면 union 이 아니라 덮어쓰기가 된다.
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      code: '005930', from: '20260814', to: '20260814', venue: 'KRX', bucket_ms: 60_000,
      candles: [...barsFor('20260814'), ...barsFor('20260813'), ...barsFor('20260812')],
      cached_dates: [], fresh_dates: [], data_warnings: [],
      adjust_factors: { '20260814': 1, '20260813': 1, '20260812': 1 },
    } as LivePastCandlesResponse as never);
    const { result } = renderHook(
      () => useMinuteGapFill({ ...BASE, missingDates: missing('20260814') }),
      { wrapper: wrap(newClient()) },
    );

    await waitFor(() => expect(result.current.remainingRuns).toBe(0));
    expect([...result.current.filledDates]).toEqual(['20260814']);
  });
});

describe('useMinuteGapFill — 실패', () => {
  it('한 run 이 실패해도 나머지를 계속한다', async () => {
    let call = 0;
    vi.spyOn(client, 'apiCall').mockImplementation(async (url: string) => {
      call += 1;
      if (call === 1) throw new Error('503 not wired');
      const params = new URLSearchParams(url.split('?')[1]);
      const from = params.get('from')!;
      return {
        code: '005930', from, to: params.get('to')!, venue: 'KRX', bucket_ms: 60_000,
        candles: barsFor(from), cached_dates: [], fresh_dates: [from], data_warnings: [],
        adjust_factors: { [from]: 1 },
      } as LivePastCandlesResponse as never;
    });
    const { result } = renderHook(
      () => useMinuteGapFill({ ...BASE, missingDates: missing('20260401', '20260801') }),
      { wrapper: wrap(newClient()) },
    );

    await waitFor(() => expect(result.current.remainingRuns).toBe(0));
    // 최신 run(0801)이 먼저 실패했고, 오래된 run(0401)은 그대로 채워졌다.
    expect([...result.current.filledDates]).toEqual(['20260401']);
  });
});
