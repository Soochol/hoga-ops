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
 * ① **안 켜져야 할 곳에서 벤더를 두드리는 것.** 게이트가 셋이라(디스크 창 · 분봉 · KRX)
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

  it('디스크 창이 아니면 침묵한다 — 전역 우회 모드에서 벤더를 두드리지 않는다', async () => {
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

  it('창이 자라도 이미 받은 날짜는 다시 요청하지 않는다 — 겹침 없는 증분 요청', async () => {
    // 2026-08-25 실측(010140 5m, 06-15~07-02 구멍): 창이 7일 타일로 자라며
    // missing_dates 가 왼쪽으로 늘 때마다 계획이 매번 커져 0624~0702 ⊂ 0617~0702 ⊂
    // 0611~0702 세 번을 겹쳐 페치했다(55→94→126KB). 이미 흡수한 날짜는 run 계획에서
    // 빼면 다음 요청이 **새 날짜만** 덮는다 — 구멍 건너기의 빈 화면 시간이 그만큼 준다.
    const spy = stubBackend(['20260629', '20260630', '20260701', '20260702']);
    const { result, rerender } = renderHook(
      (p: UseMinuteGapFillArgs) => useMinuteGapFill(p),
      { wrapper: wrap(newClient()), initialProps: { ...BASE, missingDates: missing('20260701', '20260702') } },
    );
    await waitFor(() => expect(result.current.filledDates.size).toBe(2));
    expect(spy.mock.calls[0][0]).toContain('from=20260701');

    // 창 확장: 구멍이 왼쪽으로 자란다(연속 구간 — 병합 규칙상 한 run 으로 합쳐지는 모양).
    rerender({ ...BASE, missingDates: missing('20260629', '20260630', '20260701', '20260702') });
    await waitFor(() => expect(result.current.filledDates.size).toBe(4));

    const second = spy.mock.calls.at(-1)?.[0] as string;
    expect(second).toContain('from=20260629');
    // 이미 받은 0701~0702 를 다시 포함하면 안 된다 — to 가 새 날짜의 끝에서 멎는다.
    expect(second).toContain('to=20260630');
  });

  it('진행 중 run 은 계획이 자라도 붙든다 — 미완 fetch 를 상위집합으로 갈아타지 않는다', async () => {
    // 흡수 전에 창이 또 자라면(서버가 빠를 때의 실제 순서) 재계획이 상위집합 run 을
    // 만들고, 거기로 갈아타는 순간 미완 fetch 는 버려지고 같은 구간을 다시 받는다 —
    // 날짜 증분화만으로는 못 막는 두 번째 겹침 경로다(도그푸딩 실측: 0702 →
    // 0625~0702 → 0618~0702 → 0611~0702). 진행 중 run 은 settle 까지 붙들어야
    // 흡수 → 증분 재계획의 순서가 보장된다.
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const days = ['20260629', '20260630', '20260701', '20260702'];
    const spy = vi.spyOn(client, 'apiCall').mockImplementation(async (url: string) => {
      const params = new URLSearchParams(url.split('?')[1]);
      const from = params.get('from')!;
      const to = params.get('to')!;
      if (spy.mock.calls.length === 1) await gate; // 첫 요청을 미완으로 붙든다
      const covered = days.filter((d) => d >= from && d <= to);
      return {
        code: params.get('code')!, from, to, venue: 'KRX', bucket_ms: 60_000,
        candles: covered.flatMap(barsFor), cached_dates: [], fresh_dates: covered,
        data_warnings: [], adjust_factors: Object.fromEntries(covered.map((d) => [d, 1])),
      } as LivePastCandlesResponse as never;
    });

    const { result, rerender } = renderHook(
      (p: UseMinuteGapFillArgs) => useMinuteGapFill(p),
      { wrapper: wrap(newClient()), initialProps: { ...BASE, missingDates: missing('20260701', '20260702') } },
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));

    // 첫 요청이 아직 미완인 채 창이 자란다 — 갈아타면 여기서 두 번째 요청이 나간다.
    rerender({ ...BASE, missingDates: missing('20260629', '20260630', '20260701', '20260702') });
    await new Promise((r) => setTimeout(r, 60));
    expect(spy).toHaveBeenCalledTimes(1);

    release();
    await waitFor(() => expect(result.current.filledDates.size).toBe(4));
    const second = spy.mock.calls.at(-1)?.[0] as string;
    expect(second).toContain('from=20260629');
    expect(second).toContain('to=20260630');
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

/**
 * 창이 **자라는** 소비자(창별 hogaplay 소스)를 위한 누적 정책.
 *
 * **막는 방향**: 좌측 팬으로 `missing_dates` 가 자랄 때 ① 채운 날짜가 **중간에 줄었다
 * 다시 느는 것** ② 창에서 빠진 날짜가 차트에 남는 것.
 *
 * ## ⚠ 단언이 **렌더 궤적**인 이유 — 동기 시점은 판별력이 없다
 *
 * 처음엔 `rerender` 직후 동기 시점에서 `filledDates` 를 봤는데 **옛 정책을 주입해도
 * 초록이었다.** RTL 의 `rerender` 는 `act()` 로 감싸므로 렌더 → effect → 재렌더가 한
 * 덩어리로 끝나고, 누적을 버려도 react-query 캐시(`staleTime: Infinity`)가 같은 사이클
 * 안에서 즉시 되채운다. `result.current` 는 그 **최종값만** 보여 준다.
 *
 * 브라우저에서는 `useEffect` 가 paint **이후**라 그 중간 상태가 실제 프레임으로 보인다.
 * 그것을 잴 수 있는 결정론적 대체물이 **렌더마다 찍은 값의 수열**이다 — 옛 정책은
 * `1 → 0 → …` 를 지나고 새 정책은 지나지 않는다.
 *
 * 같은 이유로 "이미 받은 run 을 다시 요청하지 않는다" 는 **재지 않는다.** 옛 정책도
 * 캐시 덕에 `apiCall` 을 다시 부르지 않아 호출 수가 같다 — 빨개질 수 없는 단언이다.
 *
 * **못 보는 것**: 저장뷰(얼림)에서는 계획이 애초에 안 바뀌므로 이 항목들이 실효가 없다.
 * 여기서 재는 것은 hogaplay 토글이 만든 새 상황이다.
 */
describe('useMinuteGapFill — 창이 자랄 때의 누적', () => {
  /** 렌더마다 값을 찍는 훅 래퍼. 반환은 `renderHook` 의 것과 같고 궤적만 곁들인다. */
  function traceFilledCount(trace: number[]) {
    return (props: { dates: string[] }) => {
      const r = useMinuteGapFill({ ...BASE, missingDates: missing(...props.dates) });
      trace.push(r.filledDates.size);
      return r;
    };
  }

  it('계획이 자라도 채운 날짜 수가 도중에 줄지 않는다', async () => {
    const spy = stubBackend(['20260701', '20260814']);
    const trace: number[] = [];
    const { result, rerender } = renderHook(traceFilledCount(trace), {
      wrapper: wrap(newClient()),
      initialProps: { dates: ['20260814'] },
    });
    await waitFor(() => expect(result.current.filledDates.size).toBe(1));

    // 좌측 팬 — 더 오래된 구멍이 계획 앞에 붙는다.
    const before = trace.length;
    rerender({ dates: ['20260701', '20260814'] });
    await waitFor(() => expect(result.current.filledDates.size).toBe(2));

    // ⚠ 이 단언이 이 테스트의 전부다. 첫 보충이 끝난 뒤로는 단조 증가여야 한다 —
    // 누적을 버리는 정책은 여기서 0 을 지난다.
    const after = trace.slice(before - 1);
    expect(Math.min(...after)).toBe(1);
    expect(after[after.length - 1]).toBe(2);

    // 새로 생긴 청크만 요청된다 — `chunkRun` 이 뒤(최신)에서 자르므로 기존 키가 남는다.
    expect(spy.mock.calls[spy.mock.calls.length - 1][0]).toContain('from=20260701');
  });

  it('창에서 빠진 날짜는 접기에서도 빠진다 — 요청하지 않은 구간의 봉이 붙지 않는다', async () => {
    stubBackend(['20260701', '20260814']);
    const { result, rerender } = renderHook(
      (props: { dates: string[] }) => useMinuteGapFill({ ...BASE, missingDates: missing(...props.dates) }),
      { wrapper: wrap(newClient()), initialProps: { dates: ['20260814'] } },
    );
    await waitFor(() => expect(result.current.candles).toHaveLength(1));

    // 창이 옮겨가 20260814 가 더는 이 창의 구멍이 아니다(디스크에 생겼거나 창 밖이다).
    // 누적은 남아 있으므로 `wantedDates` 필터가 없으면 그 봉이 그대로 그려진다.
    rerender({ dates: ['20260701'] });
    await waitFor(() => expect(result.current.filledDates.has('20260701')).toBe(true));

    expect(result.current.filledDates.has('20260814')).toBe(false);
    expect(result.current.candles).toHaveLength(1);
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
