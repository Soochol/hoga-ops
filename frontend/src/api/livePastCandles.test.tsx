import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  hasBlockingWarnings,
  mergedPastCandlesKey,
  mergePastCandleResponses,
  PAST_CANDLES_REFETCH_IN_BACKGROUND,
  pastCandlesRefetchInterval,
  pastCandlesRefetchOnFocus,
  pastCandlesStaleTime,
  planPastCandlesDelta,
  useLivePastCandles,
  withPastCandlesTimeout,
  type LivePastCandlesResponse,
} from './livePastCandles';
import * as client from './client';
import type { LiveWarningKind } from './dataWarnings';
import { liveVenueRefetchInterval } from '../live/liveVenuePolicy';

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const RESPONSE: LivePastCandlesResponse = {
  code: '005930',
  from: '20260501',
  to: '20260502',
  venue: 'KRX',
  candles: [
    { t_ms: 1, open: 100, high: 110, low: 95, close: 105, volume: 10 },
  ],
  cached_dates: [],
  fresh_dates: ['20260501', '20260502'],
  data_warnings: [],
};

const BLOCKED: LivePastCandlesResponse = {
  ...RESPONSE,
  // ADR-0143: blocking 판정은 `kind` 축이다 — 이 픽스처가 캐시 동작 3곳의 입력이다.
  data_warnings: [{
    date: '20260501', reason: 'capacity_overloaded', kind: 'deferred', msg: 'x', is_failure: true,
  }],
};

describe('past-candles freshness gating (range.ts parity)', () => {
  it('freezes past-only chunks, keeps today head chunk stale-checked', () => {
    // requestTo < todayKst → immutable → Infinity
    expect(pastCandlesStaleTime('20260502', '20260610')).toBe(Infinity);
    // requestTo === todayKst → today head → 60s
    expect(pastCandlesStaleTime('20260610', '20260610')).toBe(60_000);
    // unknown todayKst (study/historical) → treat as past-only → frozen
    expect(pastCandlesStaleTime('20260502', null)).toBe(Infinity);
  });

  it('past-only chunk does not poll unless it carries a blocking warning', () => {
    // clean past-only → no poll (deterministic — never touches venue policy)
    expect(pastCandlesRefetchInterval(RESPONSE, '20260502', '20260610', 'KRX')).toBe(false);
    // blocking past-only + today head both delegate to venue policy. Compare
    // against liveVenueRefetchInterval directly to stay clock-independent
    // (its value depends on session-now).
    expect(pastCandlesRefetchInterval(BLOCKED, '20260502', '20260610', 'KRX'))
      .toBe(liveVenueRefetchInterval('KRX'));
    expect(pastCandlesRefetchInterval(RESPONSE, '20260610', '20260610', 'UN'))
      .toBe(liveVenueRefetchInterval('UN'));
  });
});

// 탭 가림(document hidden) 중 정본 폴링이 멈추면 오늘 캔들이 15분 SSE 버퍼만으로
// 남다가 축출과 함께 소급 소멸한다(2026-07-29 조사). 두 플래그가 그 구멍을 막는다.
describe('past-candles tab-hidden refetch flags', () => {
  it('keeps the interval alive while the tab is hidden', () => {
    // refetchInterval:false 인 쿼리엔 돌 타이머가 없어 무조건 true 여도 no-op —
    // 이 플래그는 "기존 interval 이 배경에서도 도는가"만 게이트한다.
    expect(PAST_CANDLES_REFETCH_IN_BACKGROUND).toBe(true);
  });

  it('gates focus refetch on the same predicate as the polling interval', () => {
    // 과거 전용 청크: 폴링도 focus 재조회도 없다(비-라이브 호출자 동결 계약).
    expect(pastCandlesRefetchOnFocus(RESPONSE, '20260502', '20260610', 'KRX')).toBe(false);
    // 오늘 head·blocking 경고: 폴링이 도는 조건과 정확히 일치한다. 세션 시각에
    // 의존하므로 venue 정책과 대조해 clock-independent 하게 단언한다.
    expect(pastCandlesRefetchOnFocus(RESPONSE, '20260610', '20260610', 'KRX'))
      .toBe(liveVenueRefetchInterval('KRX') !== false);
    expect(pastCandlesRefetchOnFocus(BLOCKED, '20260502', '20260610', 'KRX'))
      .toBe(liveVenueRefetchInterval('KRX') !== false);
  });
});

function mockApiEchoingWindow() {
  return vi.spyOn(client, 'apiCall').mockImplementation(async (url: string) => {
    const params = new URLSearchParams(url.split('?')[1]);
    return {
      code: params.get('code')!,
      from: params.get('from')!,
      to: params.get('to')!,
      venue: (params.get('venue') ?? 'KRX') as LivePastCandlesResponse['venue'],
      // 서버가 되싣는 값을 그대로 흉내낸다 — placeholder 재사용 판정이 이 필드를 본다.
      bucket_ms: Number(params.get('bucket_ms') ?? 60_000),
      candles: [],
      cached_dates: [],
      fresh_dates: [],
      data_warnings: [],
    } satisfies LivePastCandlesResponse;
  });
}

describe('useLivePastCandles 탭 복귀 즉시 재조회', () => {
  beforeEach(() => vi.restoreAllMocks());

  /** jsdom 의 visibilityState 를 갈아끼우고 이벤트를 쏜다.
   *  `bubbles: true` 가 load-bearing — focusManager 는 리스너를 **window** 에 걸고
   *  (query-core/focusManager.js), 이벤트는 document 에서 발화한다. 기본값
   *  bubbles:false 로 쏘면 window 에 영영 닿지 않아 테스트가 거짓 실패한다.
   *  실제 브라우저도 visibilitychange 를 bubbles=true 로 발화하므로 이쪽이 충실한 재현. */
  function setVisibility(state: 'visible' | 'hidden') {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
    Object.defineProperty(document, 'hidden', { value: state === 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  }

  it('전역 refetchOnWindowFocus:false 를 오늘 head 청크가 override 한다', async () => {
    // 실측(2026-07-29, :5173 대조군): 탭 복귀 후 정본이 돌아오기까지 59초가 걸렸다.
    // 이 override 가 그 구멍을 닫는다 — 죽으면 증상이 조용히 부활하므로 핀으로 건다.
    //
    // 05:00 UTC = 14:00 KST → KRX 정규장 안. liveVenueRefetchInterval 이 시계
    // 의존이라 고정하지 않으면 장 마감 뒤엔 이 테스트가 뒤집힌다.
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 6, 29, 5, 0, 0));
    const spy = mockApiEchoingWindow();
    // main.tsx 와 동일한 전역 설정 — per-query 옵션이 실제로 이기는지가 요점이다.
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });
    renderHook(
      () => useLivePastCandles('005930', '20260729', '20260729', 'KRX', '20260729'),
      { wrapper: wrap(qc) },
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));

    // 탭 가림 → 그 사이 데이터가 낡았다고만 표시(refetchType:'none' 이라 재조회 없음).
    setVisibility('hidden');
    await qc.invalidateQueries({ refetchType: 'none' });
    expect(spy).toHaveBeenCalledTimes(1);

    // 탭 복귀 → 다음 interval 틱(최대 60s)을 기다리지 않고 즉시 1회.
    setVisibility('visible');
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });
});

describe('useLivePastCandles', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('fetches candles for given code+from+to', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(RESPONSE);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useLivePastCandles('005930', '20260501', '20260502'),
      { wrapper: wrap(qc) },
    );
    await waitFor(() => expect(result.current.data?.candles).toHaveLength(1));
    expect(spy).toHaveBeenCalledWith(
      '/api/live/past-candles?code=005930&from=20260501&to=20260502&venue=KRX&bucket_ms=60000',
      { signal: expect.any(AbortSignal) },
    );
  });

  it('기준선이 없으면 최신 15일 청크만 먼저 요청한다', async () => {
    const spy = mockApiEchoingWindow();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(
      () => useLivePastCandles('005930', '20260101', '20260707'),
      { wrapper: wrap(qc) },
    );
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0]).toBe(
      '/api/live/past-candles?code=005930&from=20260623&to=20260707&venue=KRX&bucket_ms=60000',
    );
  });

  it('청크 단위로 seed from까지 자동 워크백한다', async () => {
    const spy = mockApiEchoingWindow();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(
      () => useLivePastCandles('005930', '20260601', '20260707'),
      { wrapper: wrap(qc) },
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(3), { timeout: 3000 });
    const urls = spy.mock.calls.map((c) => c[0]);
    expect(urls).toEqual([
      '/api/live/past-candles?code=005930&from=20260623&to=20260707&venue=KRX&bucket_ms=60000',
      '/api/live/past-candles?code=005930&from=20260608&to=20260622&venue=KRX&bucket_ms=60000',
      '/api/live/past-candles?code=005930&from=20260601&to=20260607&venue=KRX&bucket_ms=60000',
    ]);
    await new Promise((r) => setTimeout(r, 100));
    expect(spy).toHaveBeenCalledTimes(3);
  });

  // Regression(2026-07-10, 통합 venue 중간 캔들 갭): 기준선이 창을 다 덮으면
  // plan이 enabled:false로 쿼리를 꺼 head 청크의 장중 60초 refetchInterval이
  // 초기 로드 직후 죽었다. 오늘 캔들의 REST 정본이 동결되면 WS 오버레이(15분
  // 보존 버퍼)만 남아 축출과 함께 캔들이 소급 소멸한다. 창이 오늘을 포함하면
  // 오늘-델타(from=to=today) 쿼리로 전환해 옵저버·폴링을 살려야 한다.
  it('기준선이 창을 다 덮어도 오늘 포함 창은 오늘-델타로 폴링을 유지한다', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockImplementation(async (url: string) => {
      const params = new URLSearchParams(url.split('?')[1]);
      return {
        code: params.get('code')!,
        from: params.get('from')!,
        to: params.get('to')!,
        venue: (params.get('venue') ?? 'KRX') as LivePastCandlesResponse['venue'],
        // from을 t_ms로 새겨 어느 요청의 캔들인지 식별 가능하게 한다.
        candles: [{ t_ms: Number(params.get('from')), open: 1, high: 1, low: 1, close: 1, volume: 1 }],
        cached_dates: [],
        fresh_dates: [],
        data_warnings: [],
      } satisfies LivePastCandlesResponse;
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useLivePastCandles('005930', '20260705', '20260710', 'UN', '20260710'),
      { wrapper: wrap(qc) },
    );
    // 청크 1방으로 창 커버 → 곧바로 오늘-델타가 발사돼야 한다.
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    const urls = spy.mock.calls.map((c) => c[0]);
    expect(urls).toEqual([
      '/api/live/past-candles?code=005930&from=20260705&to=20260710&venue=UN&bucket_ms=60000',
      '/api/live/past-candles?code=005930&from=20260710&to=20260710&venue=UN&bucket_ms=60000',
    ]);
    // 오늘-델타 응답이 기준선에 병합돼 서빙된다(청크 캔들 + 오늘 캔들).
    await waitFor(() =>
      expect(result.current.data?.candles.map((c) => c.t_ms)).toEqual([20260705, 20260710]));
    // 같은 키 재조회는 refetchInterval 몫 — 즉시 재발사 루프는 없어야 한다.
    await new Promise((r) => setTimeout(r, 100));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('todayKst 미지정(과거 전용)이면 커버 완료 후 기존처럼 동결된다', () => {
    const baseline: LivePastCandlesResponse = {
      ...RESPONSE,
      from: '20260501',
      to: '20260502',
    };
    const plan = planPastCandlesDelta('005930', '20260501', '20260502', 'KRX', baseline);
    expect(plan.enabled).toBe(false);
    expect(plan.servePrevious).toBe(true);
  });

  it('과거 전용 창(to < todayKst)은 커버 완료 후 오늘-델타를 발사하지 않는다', () => {
    const baseline: LivePastCandlesResponse = {
      ...RESPONSE,
      from: '20260501',
      to: '20260502',
    };
    const plan = planPastCandlesDelta('005930', '20260501', '20260502', 'KRX', baseline, '20260710');
    expect(plan.enabled).toBe(false);
  });

  it('오늘-델타 병합은 같은 t_ms에서 새 응답(forming 캔들 갱신)이 이긴다', () => {
    const previous: LivePastCandlesResponse = {
      ...RESPONSE,
      from: '20260705',
      to: '20260710',
      candles: [
        { t_ms: 100, open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { t_ms: 200, open: 2, high: 2, low: 2, close: 2, volume: 2 },
      ],
    };
    const next: LivePastCandlesResponse = {
      ...RESPONSE,
      from: '20260710',
      to: '20260710',
      candles: [{ t_ms: 200, open: 2, high: 3, low: 2, close: 3, volume: 9 }],
    };
    const merged = mergePastCandleResponses(previous, next);
    expect(merged.from).toBe('20260705');
    expect(merged.to).toBe('20260710');
    expect(merged.candles).toEqual([
      { t_ms: 100, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { t_ms: 200, open: 2, high: 3, low: 2, close: 3, volume: 9 },
    ]);
  });

  // Regression(2026-07-08, /study 플래시): 워크백 청크 N≥3에서 placeholderData
  // 체인(prev.to === to)이 끊겨 raw query.isLoading이 재점화하지만, 훅의 isLoading은
  // "보여줄 데이터가 전무"만 의미해야 한다. StudyPage가 훅 isLoading을 풀스크린 로딩
  // 게이트로 쓰므로, 첫 청크 도착 후 isLoading이 다시 true가 되면 차트가
  // 언마운트→재마운트하며 로딩 화면으로 되돌아가는 플래시가 발생한다. 기존
  // 2청크 워크백 테스트는 청크2가 placeholder로 유지돼 이 결함을 못 잡았다(경계 다음 케이스).
  it('첫 청크 도착 후 후속 워크백 청크(≥3)에서 isLoading이 다시 true가 되지 않는다', async () => {
    vi.spyOn(client, 'apiCall').mockImplementation(async (url: string) => {
      const params = new URLSearchParams(url.split('?')[1]);
      await new Promise((r) => setTimeout(r, 15));
      return {
        code: params.get('code')!,
        from: params.get('from')!,
        to: params.get('to')!,
        venue: 'KRX',
        candles: [{ t_ms: Number(params.get('from')), open: 1, high: 1, low: 1, close: 1, volume: 1 }],
        cached_dates: [],
        fresh_dates: [],
        data_warnings: [],
      } satisfies LivePastCandlesResponse;
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const loadingWhileHavingData: boolean[] = [];
    const { result } = renderHook(
      () => {
        // 60캘린더일 → 15일 청크 4개(20260623/20260608/20260524/20260509).
        const q = useLivePastCandles('005930', '20260509', '20260707', 'KRX');
        if (q.data) loadingWhileHavingData.push(q.isLoading);
        return q;
      },
      { wrapper: wrap(qc) },
    );
    // seed(20260509)까지 워크백 완료.
    await waitFor(() => expect(result.current.data?.from).toBe('20260509'), { timeout: 5000 });
    // 데이터가 존재한 어떤 렌더에서도 isLoading은 false여야 한다(청크 3·4 fetch 포함).
    expect(loadingWhileHavingData.length).toBeGreaterThan(0);
    expect(loadingWhileHavingData.every((l) => l === false)).toBe(true);
  });

  it('passes an AbortSignal to apiCall', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(RESPONSE);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useLivePastCandles('005930', '20260501', '20260502'), { wrapper: wrap(qc) });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const secondArg = spy.mock.calls[0][1] as RequestInit | undefined;
    expect(secondArg?.signal).toBeInstanceOf(AbortSignal);
  });

  it('does not fetch when code is null', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(RESPONSE);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useLivePastCandles(null, '20260501', '20260502'), { wrapper: wrap(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not fetch when from > to', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(RESPONSE);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useLivePastCandles('005930', '20260510', '20260501'), { wrapper: wrap(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(spy).not.toHaveBeenCalled();
  });

  it('queryKey changes split cache entries', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(RESPONSE);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = renderHook(
      ({ to }: { to: string }) => useLivePastCandles('005930', '20260501', to),
      { wrapper: wrap(qc), initialProps: { to: '20260502' } },
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    rerender({ to: '20260503' });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });

  it('venue changes split cache entries and URL params', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(RESPONSE);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = renderHook(
      ({ venue }: { venue: 'KRX' | 'UN' }) => useLivePastCandles('005930', '20260501', '20260502', venue),
      { wrapper: wrap(qc), initialProps: { venue: 'KRX' } },
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    rerender({ venue: 'UN' });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy.mock.calls[1][0]).toContain('venue=UN');
  });

  it('drops placeholder data when venue changes for the same code', async () => {
    let resolveNxt: (value: LivePastCandlesResponse) => void = () => {};
    const nxtPending = new Promise<LivePastCandlesResponse>((resolve) => {
      resolveNxt = resolve;
    });
    const krxResponse = { ...RESPONSE, venue: 'KRX' as const, candles: [{ ...RESPONSE.candles[0], close: 100 }] };
    const nxtResponse = { ...RESPONSE, venue: 'UN' as const, candles: [{ ...RESPONSE.candles[0], close: 200 }] };
    const spy = vi.spyOn(client, 'apiCall').mockImplementation((url) =>
      url.includes('venue=UN') ? nxtPending : Promise.resolve(krxResponse),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, rerender } = renderHook(
      ({ venue }: { venue: 'KRX' | 'UN' }) =>
        useLivePastCandles('005930', '20260501', '20260502', venue),
      { wrapper: wrap(qc), initialProps: { venue: 'KRX' } },
    );
    await waitFor(() => expect(result.current.data?.candles[0].close).toBe(100));

    rerender({ venue: 'UN' });

    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    resolveNxt(nxtResponse);
    await waitFor(() => expect(result.current.data?.candles[0].close).toBe(200));
  });

  // Regression: code-aware placeholderData prevents the previous code's
  // candle count from leaking through during a watchlist switch. Without
  // this, LiveChartRoot's initial-view effect would lock setVisibleLogicalRange
  // to the stale right edge and push the new code's latest candle off-screen.
  it('drops placeholder data when the code changes', async () => {
    const RESPONSE_005930 = { ...RESPONSE, code: '005930' };
    const RESPONSE_000660 = { ...RESPONSE, code: '000660' };
    const spy = vi.spyOn(client, 'apiCall').mockImplementation((url) =>
      Promise.resolve(url.includes('code=005930') ? RESPONSE_005930 : RESPONSE_000660),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, rerender } = renderHook(
      ({ code }: { code: string }) =>
        useLivePastCandles(code, '20260501', '20260502'),
      { wrapper: wrap(qc), initialProps: { code: '005930' } },
    );
    await waitFor(() => expect(result.current.data?.code).toBe('005930'));
    rerender({ code: '000660' });
    // Right after switching codes the placeholder must NOT be the previous
    // code's data — either undefined (loading) or already the new code's data.
    expect(result.current.data?.code).not.toBe('005930');
    await waitFor(() => expect(result.current.data?.code).toBe('000660'));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  // Same-code refetch (e.g. lazy from/to extension) must keep stale-while-
  // revalidate UX — placeholder stays so the chart doesn't blank.
  it('keeps placeholder data when only from/to changes (same code)', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(RESPONSE);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, rerender } = renderHook(
      ({ from }: { from: string }) =>
        useLivePastCandles('005930', from, '20260502'),
      { wrapper: wrap(qc), initialProps: { from: '20260501' } },
    );
    await waitFor(() => expect(result.current.data?.code).toBe('005930'));
    rerender({ from: '20260430' });
    // Same code, different range — placeholder kept while the new fetch is in flight.
    expect(result.current.data?.code).toBe('005930');
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });

  it('fetches only the missing older delta when the range extends left', async () => {
    const firstResponse: LivePastCandlesResponse = {
      ...RESPONSE,
      from: '20260501',
      to: '20260502',
      candles: [{ ...RESPONSE.candles[0], t_ms: 2, close: 102 }],
      cached_dates: ['20260501'],
      fresh_dates: ['20260502'],
      effective_sessions: [
        { date: '20260501', venue: 'KRX', open_ms: 1, close_ms: 2 },
      ],
    };
    const deltaResponse: LivePastCandlesResponse = {
      ...RESPONSE,
      from: '20260430',
      to: '20260430',
      candles: [{ ...RESPONSE.candles[0], t_ms: 1, close: 101 }],
      cached_dates: [],
      fresh_dates: ['20260430'],
      effective_sessions: [
        { date: '20260430', venue: 'KRX', open_ms: 1, close_ms: 2 },
      ],
    };
    const spy = vi.spyOn(client, 'apiCall').mockImplementation((url) =>
      Promise.resolve(url.includes('from=20260430&to=20260430') ? deltaResponse : firstResponse),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, rerender } = renderHook(
      ({ from }: { from: string }) =>
        useLivePastCandles('005930', from, '20260502'),
      { wrapper: wrap(qc), initialProps: { from: '20260501' } },
    );

    await waitFor(() => expect(result.current.data?.from).toBe('20260501'));
    rerender({ from: '20260430' });

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy.mock.calls[1][0]).toBe(
      '/api/live/past-candles?code=005930&from=20260430&to=20260430&venue=KRX&bucket_ms=60000',
    );
    await waitFor(() => expect(result.current.data?.candles.map((c) => c.close)).toEqual([101, 102]));
    expect(result.current.data?.from).toBe('20260430');
    expect(result.current.data?.to).toBe('20260502');
    expect(result.current.data?.cached_dates).toEqual(['20260501']);
    expect(result.current.data?.fresh_dates).toEqual(['20260430', '20260502']);
    await new Promise((r) => setTimeout(r, 30));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  // Regression(319660): KIS 스톰/쿨다운 중 백필 청크가 candles=[] +
  // blocking 경고(rate_limit_aborted 등)로 오면, 그 실패 창이 mergedRef에
  // "이미 받은 범위"로 박제되어 plan이 servePrevious/enabled:false로 굳고,
  // 서버가 회복돼도 영원히 재요청되지 않았다(차트 영구 구멍).
  // blocking 응답은 이번 렌더에 서빙만 하고 박제하지 않아야
  // 다음 refetch가 실패 창을 다시 요청해 자가 회복된다.
  it('blocking 경고 응답은 델타 기준에 박제되지 않는다', async () => {
    const firstResponse: LivePastCandlesResponse = {
      ...RESPONSE,
      from: '20260501',
      to: '20260502',
      candles: [{ ...RESPONSE.candles[0], t_ms: 2, close: 102 }],
      cached_dates: ['20260501'],
      fresh_dates: ['20260502'],
    };
    const blockedDelta: LivePastCandlesResponse = {
      ...RESPONSE,
      from: '20260430',
      to: '20260430',
      candles: [],
      cached_dates: [],
      fresh_dates: [],
      data_warnings: [{
        date: '20260430', reason: 'rate_limit_aborted', kind: 'rate_limit', msg: 'cooldown',
      }],
    };
    const recoveredDelta: LivePastCandlesResponse = {
      ...blockedDelta,
      candles: [{ ...RESPONSE.candles[0], t_ms: 1, close: 101 }],
      fresh_dates: ['20260430'],
      data_warnings: [],
    };
    let deltaCalls = 0;
    vi.spyOn(client, 'apiCall').mockImplementation((url) => {
      if (url.includes('from=20260430&to=20260430')) {
        deltaCalls += 1;
        return Promise.resolve(deltaCalls === 1 ? blockedDelta : recoveredDelta);
      }
      return Promise.resolve(firstResponse);
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, rerender } = renderHook(
      ({ from }: { from: string }) =>
        useLivePastCandles('005930', from, '20260502'),
      { wrapper: wrap(qc), initialProps: { from: '20260501' } },
    );
    await waitFor(() => expect(result.current.data?.from).toBe('20260501'));

    rerender({ from: '20260430' });
    await waitFor(() => expect(deltaCalls).toBe(1));
    // 이번 렌더에는 기존 캔들이 그대로 서빙된다 — 부분 데이터는 계속 보인다.
    await waitFor(() =>
      expect(result.current.data?.candles.map((c) => c.close)).toEqual([102]));

    // 서버 회복 시나리오: 후속 리렌더(plan 재계산) 뒤 스테일 무효화가
    // 실패 창을 재요청해야 한다. 박제 버그 상태에서는 리렌더 시 plan이
    // servePrevious/enabled:false로 굳어 델타 쿼리의 활성 옵저버가 사라지고
    // (queryKey가 null로 전환), 무효화해도 재요청이 영원히 일어나지 않는다.
    rerender({ from: '20260430' });
    await qc.invalidateQueries();
    await waitFor(() => expect(deltaCalls).toBe(2));
    await waitFor(() =>
      expect(result.current.data?.candles.map((c) => c.close)).toEqual([101, 102]));
    expect(result.current.data?.from).toBe('20260430');
  });

  // 가드의 반대 방향: 정상(경고 없는) 델타 응답은 여전히 박제되어,
  // 이후 무효화/리렌더에서 같은 창을 중복 요청하지 않는다(servePrevious 유지).
  it('정상 응답은 여전히 박제되어 중복 요청이 없다', async () => {
    const firstResponse: LivePastCandlesResponse = {
      ...RESPONSE,
      from: '20260501',
      to: '20260502',
      candles: [{ ...RESPONSE.candles[0], t_ms: 2, close: 102 }],
    };
    const goodDelta: LivePastCandlesResponse = {
      ...RESPONSE,
      from: '20260430',
      to: '20260430',
      candles: [{ ...RESPONSE.candles[0], t_ms: 1, close: 101 }],
      fresh_dates: ['20260430'],
    };
    let deltaCalls = 0;
    const spy = vi.spyOn(client, 'apiCall').mockImplementation((url) => {
      if (url.includes('from=20260430&to=20260430')) {
        deltaCalls += 1;
        return Promise.resolve(goodDelta);
      }
      return Promise.resolve(firstResponse);
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, rerender } = renderHook(
      ({ from }: { from: string }) =>
        useLivePastCandles('005930', from, '20260502'),
      { wrapper: wrap(qc), initialProps: { from: '20260501' } },
    );
    await waitFor(() => expect(result.current.data?.from).toBe('20260501'));

    rerender({ from: '20260430' });
    await waitFor(() =>
      expect(result.current.data?.candles.map((c) => c.close)).toEqual([101, 102]));
    expect(deltaCalls).toBe(1);

    // 박제됨 → 후속 리렌더에서 plan이 servePrevious로 전환돼 델타 쿼리의
    // 활성 옵저버가 사라진다 — 이후 무효화해도 재요청 없음.
    rerender({ from: '20260430' });
    await qc.invalidateQueries();
    await new Promise((r) => setTimeout(r, 30));
    expect(deltaCalls).toBe(1);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('does not reuse a previous range when the requested to-date changes', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(RESPONSE);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = renderHook(
      ({ from, to }: { from: string; to: string }) =>
        useLivePastCandles('005930', from, to),
      { wrapper: wrap(qc), initialProps: { from: '20260501', to: '20260502' } },
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));

    rerender({ from: '20260430', to: '20260503' });

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy.mock.calls[1][0]).toBe(
      '/api/live/past-candles?code=005930&from=20260430&to=20260503&venue=KRX&bucket_ms=60000',
    );
  });
});

describe('withPastCandlesTimeout', () => {
  it('원본 signal의 abort가 전파된다', () => {
    const c = new AbortController();
    const s = withPastCandlesTimeout(c.signal, 60_000);
    c.abort();
    expect(s.aborted).toBe(true);
  });

  it('타임아웃 경과 시 abort된다', async () => {
    const s = withPastCandlesTimeout(new AbortController().signal, 10);
    await new Promise((r) => setTimeout(r, 50));
    expect(s.aborted).toBe(true);
  });
});

describe('hasBlockingWarnings', () => {
  // ADR-0143 이관: 판정 축이 사유 문자열 → 백엔드가 실은 `kind` 다.
  // 판정 질문은 **"그 날짜를 받았는가"** 이고, 받지 못한 실패만 blocking 이다.
  const warn = (reason: string, kind: LiveWarningKind) => ({
    date: '20260430', reason, kind, msg: 'x', is_failure: true,
  });

  it.each([
    ['transport_error', 'transport'],
    ['rate_limit_upstream', 'rate_limit'],
    ['rate_limit_aborted', 'rate_limit'],
    ['api_error', 'vendor_api'],
    ['auth_error', 'auth'],
    ['batch_limit_exceeded', 'batch_limit'],
    ['unexpected_error', 'unexpected'],
    ['capacity_overloaded', 'deferred'],
    ['fetch_budget_exhausted', 'deferred'],
  ] as const)('받지 못한 실패 %s(kind=%s) 는 blocking', (reason, kind) => {
    expect(hasBlockingWarnings({ ...RESPONSE, data_warnings: [warn(reason, kind)] })).toBe(true);
  });

  // **이 표의 유일한 미묘함** — 실패인데 blocking 이 아니다. 행 검증에 걸렸을 뿐
  // 데이터는 **받았으므로** 박제해도 구멍이 나지 않는다(ADR-0020: 표시하되 렌더).
  // `is_failure` 만으로 갈랐다면 여기서 틀렸을 것이다.
  it('invariant_violation 은 실패지만 blocking 이 아니다 — 받긴 받았다', () => {
    expect(hasBlockingWarnings({
      ...RESPONSE,
      data_warnings: [warn('invariant_violation', 'data_quality')],
    })).toBe(false);
  });

  it('정보성 경고나 빈 경고에는 false', () => {
    expect(hasBlockingWarnings({ ...RESPONSE, data_warnings: [] })).toBe(false);
    expect(hasBlockingWarnings({
      ...RESPONSE,
      data_warnings: [
        { date: '20260430', reason: 'minute_fallback_to_krx', msg: 'x', is_failure: false },
        { date: '20260430', reason: 'rest_bypassed', msg: 'x', is_failure: false },
      ],
    })).toBe(false);
  });

  // 배포 직후 gcTime(2h) 캐시의 옛 응답 — kind 가 없으면 판정할 수 없다. blocking 으로
  // 보면 멀쩡한 병합본이 박제되지 않아 워크백이 헛돌므로 false 로 기운다.
  it('kind 가 없으면 blocking 으로 보지 않는다', () => {
    expect(hasBlockingWarnings({
      ...RESPONSE,
      data_warnings: [{ date: '20260430', reason: 'transport_error', msg: 'x' }],
    })).toBe(false);
  });
});

// 탭 복귀 시 병합 기준선 1-샷 복원 (W1) — mergedRef는 훅-로컬이라 code 전환으로
// 소실되지만, 병합본을 canonical 키로 재발행해 두면 같은 QueryClient에서 재마운트
// 시 청크 워크백 리플레이 없이 복원된다.
describe('useLivePastCandles canonical 재발행/복원', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('워크백 완료 후 병합본을 canonical 키로 재발행한다', async () => {
    mockApiEchoingWindow();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useLivePastCandles('005930', '20260601', '20260707', 'KRX'),
      { wrapper: wrap(qc) },
    );
    await waitFor(() => expect(result.current.data?.from).toBe('20260601'), { timeout: 3000 });
    const published = qc.getQueryData<LivePastCandlesResponse>(
      mergedPastCandlesKey('005930', '20260707', 'KRX', 60_000),
    );
    expect(published?.from).toBe('20260601');
    expect(published?.to).toBe('20260707');
  });

  it('재마운트 시 canonical 병합본만으로 복원한다(개별 청크 캐시 없이도 fetch 0)', async () => {
    const spy = mockApiEchoingWindow();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const first = renderHook(
      () => useLivePastCandles('005930', '20260601', '20260707', 'KRX'),
      { wrapper: wrap(qc) },
    );
    await waitFor(() => expect(first.result.current.data?.from).toBe('20260601'), { timeout: 3000 });
    const callsAfterWalkback = spy.mock.calls.length;
    expect(callsAfterWalkback).toBe(3); // 15일 청크 × 3
    first.unmount();

    // 개별 청크 엔트리를 전부 제거하고 canonical 병합본만 남긴다 — 복원이
    // 청크 캐시가 아니라 canonical 재발행에 기인함을 격리 검증한다.
    qc.removeQueries({ queryKey: ['live', 'past-candles', '005930'], exact: false });
    qc.getQueryCache().getAll()
      .filter((q) => {
        const k = q.queryKey as unknown[];
        return k[0] === 'live' && k[1] === 'past-candles' && k[2] !== 'merged';
      })
      .forEach((q) => qc.getQueryCache().remove(q));
    // canonical 은 살아 있어야 한다.
    expect(qc.getQueryData(mergedPastCandlesKey('005930', '20260707', 'KRX', 60_000))).toBeTruthy();

    const second = renderHook(
      () => useLivePastCandles('005930', '20260601', '20260707', 'KRX'),
      { wrapper: wrap(qc) },
    );
    await waitFor(() => expect(second.result.current.data?.from).toBe('20260601'));
    await new Promise((r) => setTimeout(r, 60));
    // 청크를 지웠는데도 복원됐다면 canonical 경로가 작동한 것 — 추가 fetch 0.
    expect(spy.mock.calls.length).toBe(callsAfterWalkback);
  });

  it('부분 복원: canonical이 seed보다 얕으면 부족분 청크만 요청한다', async () => {
    const spy = mockApiEchoingWindow();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // canonical 을 20260623~20260707 만 커버하도록 직접 심는다(첫 청크만 받은 상태).
    qc.setQueryData(mergedPastCandlesKey('005930', '20260707', 'KRX', 60_000), {
      code: '005930', from: '20260623', to: '20260707', venue: 'KRX',
      candles: [], cached_dates: [], fresh_dates: [], data_warnings: [],
    } satisfies LivePastCandlesResponse);

    const { result } = renderHook(
      () => useLivePastCandles('005930', '20260601', '20260707', 'KRX'),
      { wrapper: wrap(qc) },
    );
    await waitFor(() => expect(result.current.data?.from).toBe('20260601'), { timeout: 3000 });
    const urls = spy.mock.calls.map((c) => c[0]);
    // 첫 청크(20260623~20260707)는 복원됐으므로 재요청 없이, 그 아래부터만 워크백.
    expect(urls).toEqual([
      '/api/live/past-candles?code=005930&from=20260608&to=20260622&venue=KRX&bucket_ms=60000',
      '/api/live/past-candles?code=005930&from=20260601&to=20260607&venue=KRX&bucket_ms=60000',
    ]);
  });

  it('다른 to/venue/code canonical은 복원에 쓰이지 않는다', async () => {
    const spy = mockApiEchoingWindow();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // 다른 to 로 심어두면 이번 identity(to=20260707)와 불일치 → 무시.
    qc.setQueryData(mergedPastCandlesKey('005930', '20260630', 'KRX', 60_000), {
      code: '005930', from: '20260601', to: '20260630', venue: 'KRX',
      candles: [], cached_dates: [], fresh_dates: [], data_warnings: [],
    } satisfies LivePastCandlesResponse);
    renderHook(
      () => useLivePastCandles('005930', '20260601', '20260707', 'KRX'),
      { wrapper: wrap(qc) },
    );
    // 복원 실패 → 최신 15일 청크부터 풀 워크백 시작.
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0]).toBe(
      '/api/live/past-candles?code=005930&from=20260623&to=20260707&venue=KRX&bucket_ms=60000',
    );
  });

  it('blocking 경고 병합본은 canonical에 재발행되지 않는다', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      ...RESPONSE, from: '20260501', to: '20260502',
      candles: [],
      data_warnings: [{
        date: '20260501', reason: 'rate_limit_upstream', kind: 'rate_limit', msg: 'x',
      }],
    } satisfies LivePastCandlesResponse);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useLivePastCandles('005930', '20260501', '20260502', 'KRX'),
      { wrapper: wrap(qc) },
    );
    await waitFor(() => expect(result.current.data).toBeTruthy());
    await new Promise((r) => setTimeout(r, 40));
    expect(qc.getQueryData(mergedPastCandlesKey('005930', '20260502', 'KRX', 60_000))).toBeUndefined();
  });

  it('창≤15일 로드는 재발행 루프를 만들지 않는다(apiCall 1회 유지)', async () => {
    const spy = mockApiEchoingWindow();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(
      () => useLivePastCandles('005930', '20260701', '20260707', 'KRX'),
      { wrapper: wrap(qc) },
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 80));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('표시 tf 를 bucket_ms 로 실어 보낸다', async () => {
    const spy = mockApiEchoingWindow();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(
      () => useLivePastCandles('005930', '20260701', '20260707', 'KRX', null, 600_000),
      { wrapper: wrap(qc) },
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0][0]).toContain('bucket_ms=600000');
  });

  it('tf 가 다르면 병합본이 섞이지 않는다', async () => {
    const spy = mockApiEchoingWindow();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // 1분 병합본을 심어 둔다. 10분 훅이 이걸 복원하면 **틀린 해상도**를 그린다 —
    // 봉 개수만 달라지고 에러는 안 나므로 키 분리가 유일한 방어선이다.
    qc.setQueryData(mergedPastCandlesKey('005930', '20260707', 'KRX', 60_000), {
      code: '005930', from: '20260101', to: '20260707', venue: 'KRX', bucket_ms: 60_000,
      candles: [], cached_dates: [], fresh_dates: [], data_warnings: [],
    } satisfies LivePastCandlesResponse);

    renderHook(
      () => useLivePastCandles('005930', '20260701', '20260707', 'KRX', null, 600_000),
      { wrapper: wrap(qc) },
    );

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    // 1분 병합본(from=20260101)을 재사용했다면 요청 창이 그 뒤부터 시작했을 것이다.
    expect(spy.mock.calls[0][0]).toContain('from=20260701');
    expect(spy.mock.calls[0][0]).toContain('bucket_ms=600000');
  });
});
