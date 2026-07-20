/**
 * WS 체결 틱 → 리스트 등락률 오버레이 (liveQuotes seam 안에서 합성).
 *
 * 핵심 불변식은 "기준가 공유"다: 틱 파생 등락률과 폴링 등락률이 같은 기준가
 * (previous_close)를 써야, 둘이 번갈아 반영돼도 값이 튀지 않는다. 그래서
 * baseline_price 가 아니라 price - change_won 으로 기준가를 복원한다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { useLiveQuoteOverlay, type LiveQuote } from './liveQuotes';
import { MAX_TICK_SUBSCRIBED_CODES } from './liveTickOverlay';
import * as client from './client';
import * as ws from './ws';

/** 코드별로 붙은 live 핸들러 — 테스트에서 틱을 밀어 넣는 통로. */
const handlers = new Map<string, (d: unknown) => void>();
const unsubSpy = vi.fn();

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

/** trade 프레임 한 건 밀어넣고 스로틀 창(150ms)을 넘긴다.
 *  prevClose 를 주면 키움 FID 11 유도 전일종가가 실린 프레임을 흉내낸다. */
function pushTrade(code: string, price: number, prevClose?: number): void {
  act(() => {
    const frame: Record<string, unknown> = {
      t_ms: 1, kind: 'trade', trades: [{ t_ms: 1, price, qty: 1 }],
    };
    if (prevClose !== undefined) frame.prev_close = prevClose;
    handlers.get(code)?.(frame);
    vi.advanceTimersByTime(200);
  });
}

function mockQuotes(quotes: Partial<LiveQuote>[]): void {
  vi.spyOn(client, 'apiCall').mockResolvedValue({ phase: 'open', quotes });
}

async function renderOverlay(codes: string[]) {
  const hook = renderHook(() => useLiveQuoteOverlay(codes), { wrapper: wrap() });
  await waitFor(() => expect(hook.result.current.quoteByCode.size).toBeGreaterThan(0));
  return hook;
}

beforeEach(() => {
  handlers.clear();
  unsubSpy.mockClear();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.spyOn(ws, 'subscribeLive').mockImplementation((code, handler) => {
    handlers.set(code, handler as (d: unknown) => void);
    return () => { handlers.delete(code); unsubSpy(code); };
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('WS 틱 등락률 오버레이', () => {
  it('체결 틱이 오면 등락률을 재계산한다 — 폴링을 기다리지 않는다', async () => {
    // 기준가 255,000 (= 244500 - (-10500))
    mockQuotes([{ code: '005930', price: 244500, change_pct: -4.12, change_won: -10500 }]);
    const { result } = await renderOverlay(['005930']);

    expect(result.current.quoteByCode.get('005930')?.change_pct).toBe(-4.12);

    pushTrade('005930', 249000);

    const q = result.current.quoteByCode.get('005930');
    expect(q?.price).toBe(249000);
    // (249000 / 255000 - 1) * 100 = -2.3529... → -2.35
    expect(q?.change_pct).toBe(-2.35);
    expect(q?.change_won).toBe(-6000);
    expect(q?.change_pct_source).toBe('ws_tick');
  });

  it('기준가를 baseline_price 가 아니라 price - change_won 으로 복원한다', async () => {
    // baseline_price(수정주가 검증용)와 실제 등락 기준가가 다른 경우. 후자를 써야
    // 폴링값과 틱 파생값이 같은 기준선 위에 놓인다.
    mockQuotes([{
      code: '049080',
      price: 7770,
      change_pct: -21.75,
      change_won: -2160, // → 기준가 9930
      baseline_price: 5000, // 미끼: 이걸 쓰면 change_pct 가 +55.4 로 튄다
    }]);
    const { result } = await renderOverlay(['049080']);

    pushTrade('049080', 8000);

    const q = result.current.quoteByCode.get('049080');
    // (8000 / 9930 - 1) * 100 = -19.4360... → -19.44
    expect(q?.change_pct).toBe(-19.44);
    expect(q?.change_won).toBe(-1930);
  });

  it('change_won 이 없으면 baseline_price 로 폴백한다', async () => {
    mockQuotes([{ code: '005930', price: 51000, change_pct: 2, change_won: null, baseline_price: 50000 }]);
    const { result } = await renderOverlay(['005930']);

    pushTrade('005930', 52500);

    expect(result.current.quoteByCode.get('005930')?.change_pct).toBe(5);
  });

  it('기준가를 복원할 수 없으면(NXT 무거래 등) 폴링값을 그대로 둔다', async () => {
    // price=0 · change_pct=null · baseline 없음 = quote_change_resolver 의
    // unavailable. 여기서 틱 가격만으로 등락률을 지어내면 안 된다.
    mockQuotes([{
      code: '475150',
      price: 0,
      change_pct: null,
      change_won: null,
      baseline_price: null,
      change_pct_source: 'unavailable',
    }]);
    const { result } = await renderOverlay(['475150']);

    pushTrade('475150', 55900);

    const q = result.current.quoteByCode.get('475150');
    expect(q?.change_pct).toBeNull();
    expect(q?.change_pct_source).toBe('unavailable');
  });

  it('틱이 안 온 코드는 폴링값을 유지한다', async () => {
    mockQuotes([
      { code: '005930', price: 244500, change_pct: -4.12, change_won: -10500 },
      { code: '000660', price: 1790000, change_pct: -2.82, change_won: -52000 },
    ]);
    const { result } = await renderOverlay(['005930', '000660']);

    pushTrade('005930', 249000);

    expect(result.current.quoteByCode.get('005930')?.change_pct).toBe(-2.35);
    expect(result.current.quoteByCode.get('000660')?.change_pct).toBe(-2.82);
    expect(result.current.quoteByCode.get('000660')?.change_pct_source).toBeUndefined();
  });

  it('구독 코드 수를 상한으로 자른다 — 대형 리스트는 폴링으로 degrade', async () => {
    const codes = Array.from({ length: MAX_TICK_SUBSCRIBED_CODES + 10 }, (_, i) =>
      String(i).padStart(6, '0'));
    mockQuotes(codes.map((code) => ({ code, price: 1000, change_pct: 0, change_won: 0 })));
    await renderOverlay(codes);

    expect(handlers.size).toBe(MAX_TICK_SUBSCRIBED_CODES);
  });

  it('구독 집합이 바뀌면 이전 구독을 해제한다', async () => {
    mockQuotes([{ code: '005930', price: 244500, change_pct: -4.12, change_won: -10500 }]);
    const { rerender } = renderHook(({ codes }) => useLiveQuoteOverlay(codes), {
      wrapper: wrap(),
      initialProps: { codes: ['005930'] },
    });
    await waitFor(() => expect(handlers.has('005930')).toBe(true));

    rerender({ codes: ['000660'] });

    await waitFor(() => expect(unsubSpy).toHaveBeenCalledWith('005930'));
    expect(handlers.has('005930')).toBe(false);
  });

  it('같은 집합의 재정렬은 재구독을 일으키지 않는다', async () => {
    mockQuotes([
      { code: '005930', price: 244500, change_pct: -4.12, change_won: -10500 },
      { code: '000660', price: 1790000, change_pct: -2.82, change_won: -52000 },
    ]);
    const { rerender } = renderHook(({ codes }) => useLiveQuoteOverlay(codes), {
      wrapper: wrap(),
      initialProps: { codes: ['005930', '000660'] },
    });
    await waitFor(() => expect(handlers.size).toBe(2));

    rerender({ codes: ['000660', '005930'] }); // 순서만 뒤집기

    expect(unsubSpy).not.toHaveBeenCalled();
  });

  it('여러 틱을 한 스로틀 창으로 코얼레싱한다', async () => {
    mockQuotes([{ code: '005930', price: 244500, change_pct: -4.12, change_won: -10500 }]);
    const { result } = await renderOverlay(['005930']);
    const before = result.current.quoteByCode;

    act(() => {
      for (const price of [245000, 246000, 247000]) {
        handlers.get('005930')?.({ t_ms: 1, kind: 'trade', trades: [{ price }] });
      }
      // 스로틀 창 안 — 아직 반영되지 않아야 한다.
    });
    expect(result.current.quoteByCode).toBe(before);

    act(() => { vi.advanceTimersByTime(200); });

    // 창이 닫히면 마지막 값 하나로 한 번만 반영된다.
    expect(result.current.quoteByCode.get('005930')?.price).toBe(247000);
  });

  it('price=0(venue 미거래)이면 옛 등락률을 물려주지 않는다', async () => {
    // NXT 미거래 종목은 KIS 멀티시세가 price=0 센티넬로 준다. 첫 응답은 정상,
    // 두 번째부터 미거래 — last-good 이 걸리면 옛 등락률이 영원히 박제된다.
    vi.spyOn(client, 'apiCall')
      .mockResolvedValueOnce({
        phase: 'open',
        quotes: [{ code: '003490', price: 25200, change_pct: -4.91, change_won: -1300 }],
      })
      .mockResolvedValue({
        phase: 'open',
        quotes: [{
          code: '003490',
          price: 0,
          change_pct: null,
          change_won: null,
          change_pct_source: 'unavailable',
        }],
      });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useLiveQuoteOverlay(['003490']), { wrapper });
    await waitFor(() => expect(result.current.quoteByCode.get('003490')?.change_pct).toBe(-4.91));

    await act(async () => {
      await qc.refetchQueries({ queryKey: ['live-quotes', '003490', 'KRX'] });
    });

    // 두 번째 응답 반영을 기다린다(react-query 갱신은 비동기).
    await waitFor(() => expect(result.current.quoteByCode.get('003490')?.price).toBe(0));

    const q = result.current.quoteByCode.get('003490');
    expect(q?.change_pct).toBeNull(); // 옛 -4.91% 가 박제되지 않는다
    expect(q?.change_pct_source).toBe('unavailable');
  });

  it('가격이 살아있는 일시적 unavailable 에는 여전히 last-good 을 물린다', async () => {
    // 회귀 가드: price>0 이면 원래 의도(깜빡임 방지)가 그대로 유지돼야 한다.
    vi.spyOn(client, 'apiCall')
      .mockResolvedValueOnce({
        phase: 'open',
        quotes: [{ code: '005930', price: 72400, change_pct: 1.2, change_won: 100 }],
      })
      .mockResolvedValue({
        phase: 'open',
        quotes: [{
          code: '005930',
          price: 72500,
          change_pct: null,
          change_won: null,
          change_pct_source: 'unavailable',
        }],
      });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useLiveQuoteOverlay(['005930']), { wrapper });
    await waitFor(() => expect(result.current.quoteByCode.get('005930')?.price).toBe(72400));

    await act(async () => {
      await qc.refetchQueries({ queryKey: ['live-quotes', '005930', 'KRX'] });
    });

    expect(result.current.quoteByCode.get('005930')?.change_pct).toBe(1.2);
  });

  it('틱이 실어 온 prev_close 를 폴링 역산값보다 우선한다', async () => {
    // 폴링 역산 기준가는 255,000(= 244500 + 10500). 틱은 250,000 을 준다.
    // ①이 이겨야 폴링 없이도 등락률이 성립한다 — 폴링 감속의 전제.
    mockQuotes([{ code: '005930', price: 244500, change_pct: -4.12, change_won: -10500 }]);
    const { result } = await renderOverlay(['005930']);

    pushTrade('005930', 249000, 250000);

    const q = result.current.quoteByCode.get('005930');
    // 틱 기준가 250,000 → (249000/250000 - 1)*100 = -0.4
    expect(q?.change_pct).toBe(-0.4);
    expect(q?.change_won).toBe(-1000);
    // 폴링 기준가 255,000 을 썼다면 -2.35 였을 것이다.
    expect(q?.change_pct).not.toBe(-2.35);
  });

  it('prev_close 가 없는 프레임(합성 틱)은 폴링 역산으로 폴백한다', async () => {
    // 거래원 REST 합성 틱·구버전 백엔드에는 prev_close 가 없다.
    mockQuotes([{ code: '005930', price: 244500, change_pct: -4.12, change_won: -10500 }]);
    const { result } = await renderOverlay(['005930']);

    pushTrade('005930', 249000); // prevClose 미지정

    expect(result.current.quoteByCode.get('005930')?.change_pct).toBe(-2.35);
  });

  it('prev_close 가 0 이하면 무시하고 폴링 역산을 쓴다', async () => {
    mockQuotes([{ code: '005930', price: 244500, change_pct: -4.12, change_won: -10500 }]);
    const { result } = await renderOverlay(['005930']);

    pushTrade('005930', 249000, 0); // 분모가 될 수 없는 값

    expect(result.current.quoteByCode.get('005930')?.change_pct).toBe(-2.35);
  });

  it('틱 결과가 폴링값과 같으면 quote 객체 identity 를 유지한다', async () => {
    // 무의미한 재렌더 churn 방지 — 소비자 memo 가 identity 로 판정한다.
    mockQuotes([{ code: '005930', price: 244500, change_pct: -4.12, change_won: -10500 }]);
    const { result } = await renderOverlay(['005930']);
    const before = result.current.quoteByCode.get('005930');

    pushTrade('005930', 244500, 255000); // 폴링과 완전히 같은 값

    expect(result.current.quoteByCode.get('005930')).toBe(before);
  });

  it('당일 OHLC 도 틱이 주면 폴링값을 덮는다', async () => {
    mockQuotes([{
      code: '005930', price: 244500, change_pct: -4.12, change_won: -10500,
      open: 250000, high: 251000, low: 244000,
    }]);
    const { result } = await renderOverlay(['005930']);

    act(() => {
      handlers.get('005930')?.({
        t_ms: 1, kind: 'trade', trades: [{ price: 249000 }],
        prev_close: 255000, day_open: 250000, day_high: 252000, day_low: 243500,
      });
      vi.advanceTimersByTime(200);
    });

    const q = result.current.quoteByCode.get('005930');
    expect(q?.high).toBe(252000); // 갱신된 고가
    expect(q?.low).toBe(243500);  // 갱신된 저가
    expect(q?.open).toBe(250000);
  });

  it('OHLC 가 없는 틱은 폴링의 OHLC 를 유지한다', async () => {
    mockQuotes([{
      code: '005930', price: 244500, change_pct: -4.12, change_won: -10500,
      open: 250000, high: 251000, low: 244000,
    }]);
    const { result } = await renderOverlay(['005930']);

    pushTrade('005930', 249000, 255000); // day_* 미포함

    const q = result.current.quoteByCode.get('005930');
    expect(q?.high).toBe(251000);
    expect(q?.low).toBe(244000);
    expect(q?.change_pct).toBe(-2.35); // 등락률은 갱신됨
  });

  it('가격이 그대로여도 고가가 갱신되면 반영한다', async () => {
    // sameSample 이 price 만 비교하면 이 케이스를 놓친다.
    mockQuotes([{
      code: '005930', price: 249000, change_pct: -2.35, change_won: -6000,
      open: 250000, high: 251000, low: 244000,
    }]);
    const { result } = await renderOverlay(['005930']);

    act(() => {
      const frame = (high: number) => ({
        t_ms: 1, kind: 'trade', trades: [{ price: 249000 }],
        prev_close: 255000, day_high: high,
      });
      handlers.get('005930')?.(frame(251000));
      vi.advanceTimersByTime(200);
      handlers.get('005930')?.(frame(253000)); // 가격 동일, 고가만 상승
      vi.advanceTimersByTime(200);
    });

    expect(result.current.quoteByCode.get('005930')?.high).toBe(253000);
  });

  it('trade 가 아닌 프레임(ob)은 무시한다', async () => {
    mockQuotes([{ code: '005930', price: 244500, change_pct: -4.12, change_won: -10500 }]);
    const { result } = await renderOverlay(['005930']);

    act(() => {
      handlers.get('005930')?.({ t_ms: 1, kind: 'ob', asks: [{ price: 300000, qty: 1 }] });
      vi.advanceTimersByTime(200);
    });

    expect(result.current.quoteByCode.get('005930')?.price).toBe(244500);
  });
});
