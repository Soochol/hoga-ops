import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { pickLastKnownOb, useLiveSeries } from './liveSeries';
import * as client from './client';
import { installFakeWebSocket, fakeSockets } from '../test/fakeWebSocket';
import { __resetForTests as resetWs } from './ws';

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('useLiveSeries', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    installFakeWebSocket();
    resetWs();
    vi.spyOn(client, 'wsUrl').mockResolvedValue('ws://localhost:8080/api/ws');
  });
  afterEach(() => { resetWs(); });

  it('fetches initial series and exposes empty buffers before any WebSocket frames', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      code: '005930',
      date: '20260527',
      session_open_ms: 1000,
      session_close_ms: null,
      is_open: true,
      snapshots: [],
      trades: [],
      brokers: [],
      programs: [],
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useLiveSeries('005930', 'KRX'), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.initial).toBeDefined());
    expect(result.current.ob).toEqual([]);
    expect(result.current.trade).toEqual([]);
    expect(result.current.broker).toEqual([]);
    expect(result.current.program).toEqual([]);
  });

  it('subscribes over WebSocket and appends code-tagged snapshots by kind', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      code: '005930', date: '20260527', session_open_ms: 1000,
      session_close_ms: null, is_open: true, snapshots: [], trades: [], brokers: [], programs: [],
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useLiveSeries('005930', 'KRX'), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.initial).toBeDefined());
    await waitFor(() => expect(fakeSockets.length).toBe(1));
    const sock = fakeSockets[0];
    sock.open();
    expect(sock.parsedSent()).toContainEqual({ action: 'subscribe', code: '005930' });
    act(() => {
      sock.message({ ch: 'live', code: '005930', data: { t_ms: 100, kind: 'ob', total_bid_qty: 999 } });
      sock.message({ ch: 'live', code: '005930', data: { t_ms: 100, kind: 'trade', trades: [] } });
      sock.message({
        ch: 'live',
        code: '005930',
        data: {
          t_ms: 101,
          kind: 'program',
          venue: 'KRX',
          net_qty: 20,
          net_amount: 2_000_000,
        },
      });
    });
    await waitFor(() => expect(result.current.ob).toHaveLength(1));
    expect(result.current.trade).toHaveLength(1);
    expect(result.current.broker).toHaveLength(0);
    expect(result.current.program).toHaveLength(1);
  });

  it('hydrates from initial series.snapshots/trades/brokers', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      code: '005930',
      date: '20260527',
      session_open_ms: 1000,
      session_close_ms: null,
      is_open: true,
      snapshots: [{ t_ms: 50 }, { t_ms: 60 }],
      trades: [{ t_ms: 50 }],
      brokers: [],
      programs: [{ t_ms: 70, kind: 'program', net_qty: 10, net_amount: 1_000_000 }],
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useLiveSeries('005930', 'KRX'), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.ob).toHaveLength(2));
    expect(result.current.trade).toHaveLength(1);
    expect(result.current.program).toHaveLength(1);
  });

  it('ignores a stale initial series payload for a previous code', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      code: '005930',
      date: '20260527',
      session_open_ms: 1000,
      session_close_ms: null,
      is_open: true,
      snapshots: [{ t_ms: 50, kind: 'ob', total_ask_qty: 12345 }],
      trades: [{ t_ms: 50, kind: 'trade', trades: [] }],
      brokers: [{ t_ms: 50, kind: 'broker', broker: 'stale' }],
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useLiveSeries('000660', 'KRX'), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.initial).toBeUndefined();
    expect(result.current.ob).toEqual([]);
    expect(result.current.trade).toEqual([]);
    expect(result.current.broker).toEqual([]);
  });

  it('unsubscribes the code on unmount', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      code: '005930', date: '20260527', session_open_ms: 1000,
      session_close_ms: null, is_open: true,
      snapshots: [], trades: [], brokers: [],
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount } = renderHook(() => useLiveSeries('005930', 'KRX'), { wrapper: wrap(qc) });
    await waitFor(() => expect(fakeSockets.length).toBe(1));
    const sock = fakeSockets[0];
    sock.open();
    unmount();
    expect(sock.parsedSent()).toContainEqual({ action: 'unsubscribe', code: '005930' });
  });

  it('filters ob/trade by the selected venue at the source (KRX drops NXT-tagged frames)', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      code: '005930', date: '20260527', session_open_ms: 1000,
      session_close_ms: null, is_open: true, snapshots: [], trades: [], brokers: [],
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useLiveSeries('005930', 'KRX'), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.initial).toBeDefined());
    await waitFor(() => expect(fakeSockets.length).toBe(1));
    const sock = fakeSockets[0];
    sock.open();
    act(() => {
      // KRX 태그·무태그(=KRX)는 통과, NXT 태그는 KRX 선택에서 소스에서 배제된다.
      sock.message({ ch: 'live', code: '005930', data: { t_ms: 100, kind: 'ob', venue: 'KRX', total_bid_qty: 1 } });
      sock.message({ ch: 'live', code: '005930', data: { t_ms: 101, kind: 'ob', venue: 'NXT', total_bid_qty: 2 } });
      sock.message({ ch: 'live', code: '005930', data: { t_ms: 102, kind: 'trade', venue: 'NXT', trades: [] } });
      sock.message({ ch: 'live', code: '005930', data: { t_ms: 103, kind: 'trade', trades: [] } });
    });
    // ob: KRX 태그 1건만(NXT 배제). trade: 무태그 1건만(NXT 배제).
    await waitFor(() => expect(result.current.ob).toHaveLength(1));
    expect(result.current.ob[0]).toMatchObject({ venue: 'KRX' });
    expect(result.current.trade).toHaveLength(1);
  });
});


// ── 빈 호가창 폴백 (2026-08-18) ────────────────────────────────────────────
//
// 15:30 이후 KRX 를 고른 사용자의 10호가 창이 **NXT 상장 종목에서만** 비었다.
// 키움 `0D` 가 15:30 에 끊긴 뒤 NXT·UN 프레임이 같은 버퍼에서 KRX 프레임을 밀어내기
// 때문이다(실측 2026-08-18: 005930 `ob` 360건이 34초치 · KRX 0건). NXT 미상장 종목은
// 밀어낼 상대가 없어 15:30 값이 남아 정상으로 보였다 — 고치는 것은 그 **대칭**이다.

const OLD_SERVED_OB = { t_ms: 100, kind: 'ob', venue: 'KRX', asks: [{ price: 1, qty: 1 }] };

function seriesBody(extra: Record<string, unknown> = {}) {
  return {
    code: '005930', date: '20260818', session_open_ms: 1000,
    session_close_ms: null, is_open: true,
    snapshots: [], trades: [], brokers: [], programs: [],
    ...extra,
  };
}

describe('pickLastKnownOb', () => {
  const latched = { t_ms: 500 } as never;
  const served = { t_ms: 100 } as never;

  it('prefers whichever frame is newer', () => {
    expect(pickLastKnownOb(latched, served)).toBe(latched);
    expect(pickLastKnownOb(served, latched)).toBe(latched);
  });

  it('falls back to whichever one exists', () => {
    expect(pickLastKnownOb(undefined, served)).toBe(served);
    expect(pickLastKnownOb(latched, undefined)).toBe(latched);
    expect(pickLastKnownOb(undefined, undefined)).toBeUndefined();
  });
});

describe('useLiveSeries — 빈 호가창 폴백', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    installFakeWebSocket();
    resetWs();
    vi.spyOn(client, 'wsUrl').mockResolvedValue('ws://localhost:8080/api/ws');
  });
  afterEach(() => { resetWs(); });

  it('serves the backend last_ob when the buffer holds no frame for this venue', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue(seriesBody({ last_ob: OLD_SERVED_OB }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useLiveSeries('005930', 'KRX'), { wrapper: wrap(qc) });

    await waitFor(() => expect(result.current.ob).toHaveLength(1));
    expect(result.current.ob[0]).toMatchObject({ t_ms: 100, venue: 'KRX' });
  });

  it('keeps the latched frame when it is newer than the served one', async () => {
    // **09:00 에 열어 둔 탭**이 이 경로다. `initial` 은 마운트 1회 조회라 그 응답의
    // last_ob 가 그 시각에 얼어 있는데, 클라이언트 축출은 몇 시간 뒤에 온다. 래치가
    // 없으면 그 순간 화면이 **몇 시간 낡은 사다리**로 바뀐다 — 빈 화면보다 나쁘다.
    vi.spyOn(client, 'apiCall').mockResolvedValue(seriesBody({ last_ob: OLD_SERVED_OB }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useLiveSeries('005930', 'KRX'), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.initial).toBeDefined());
    await waitFor(() => expect(fakeSockets.length).toBe(1));
    const sock = fakeSockets[0];
    sock.open();

    const fresh = { t_ms: 5_000, kind: 'ob', venue: 'KRX', asks: [{ price: 2, qty: 2 }] };
    act(() => { sock.message({ ch: 'live', code: '005930', data: fresh }); });
    await waitFor(() => expect(result.current.ob[0]).toMatchObject({ t_ms: 5_000 }));

    // 15분 뒤 NXT 프레임 하나면 `evictOld` 가 KRX 프레임을 버린다 — 15:30 이후
    // NXT 상장 종목에서 실제로 일어나는 일이고, 여기가 폴백이 발동하는 순간이다.
    //
    // ⚠ **`ob` 로는 그 순간을 기다릴 수 없다.** 폴백이 붙은 뒤에도 `ob` 는 길이 1 ·
    // t_ms 5,000 이라 축출 전후가 **구별되지 않고**, `waitFor` 는 조건이 이미 참이면
    // 즉시 반환하므로 단언이 축출 이전 상태를 본다(그러면 폴백을 꺼도 통과하는
    // 위양성이다 — red-check 으로 실제 관측했다). 그래서 같은 flush 에 `trade` 를
    // 하나 태워 **그것을** 기다린다: trade 가 보였다면 flush 가 끝났고 같은 flush 에
    // 들어온 `ob` 축출도 이미 적용돼 있다.
    const evictingTick = 5_000 + 16 * 60_000;
    act(() => {
      sock.message({
        ch: 'live', code: '005930',
        data: { t_ms: evictingTick, kind: 'ob', venue: 'NXT', asks: [] },
      });
      sock.message({
        ch: 'live', code: '005930',
        data: { t_ms: evictingTick, kind: 'trade', venue: 'KRX', trades: [{ price: 9 }] },
      });
    });
    await waitFor(() => expect(result.current.trade).toHaveLength(1));

    expect(result.current.ob).toHaveLength(1);
    expect(result.current.ob[0]).toMatchObject({ t_ms: 5_000, venue: 'KRX' });
  });

  it('never substitutes a frame from another venue', async () => {
    // 폴백이 필터를 우회하면 증상이 **빈 화면에서 조용히 틀린 값으로** 바뀐다.
    vi.spyOn(client, 'apiCall').mockResolvedValue(
      seriesBody({ last_ob: { ...OLD_SERVED_OB, venue: 'NXT' } }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useLiveSeries('005930', 'KRX'), { wrapper: wrap(qc) });

    await waitFor(() => expect(result.current.initial).toBeDefined());
    expect(result.current.ob).toEqual([]);
  });

  it('stays empty when the backend has no last_ob for this venue', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue(seriesBody({ last_ob: null }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useLiveSeries('005930', 'KRX'), { wrapper: wrap(qc) });

    await waitFor(() => expect(result.current.initial).toBeDefined());
    expect(result.current.ob).toEqual([]);
  });
});
