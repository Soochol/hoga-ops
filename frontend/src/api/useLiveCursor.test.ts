/**
 * Tests for useLiveCursor.ts — live-page cursor spot hooks (ADR-0044).
 *
 * Mock strategy: vi.mock('./client') at module scope intercepts apiGet for all
 * suites. Each describe block resets the mock in its own beforeEach.
 *
 * Cursor timestamps use 1_779_930_000_000 (2026-05-28 10:00:00 KST) so that
 * unixMsToKSTDate derives '20260528' — matching the URL assertions. The prior
 * 1_748_400_…ms values were 2025-05-28 KST, causing date mismatch after the
 * fix that derives date from cursorMs rather than accepting it as a prop.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { act, createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  useLiveOrderbookAtCursor,
  useLiveBrokersAtCursor,
  useLiveBrokersToday,
} from './useLiveCursor';
import { useLiveCursorStore } from '../live/useLiveCursorStore';
import { seedSymbolMaster, symbolHit } from '../live/seedSymbolMaster';
import type { SymbolHit } from './types';
import type { LiveVenueOption } from '../state/liveVenue';

// 소스 선호는 이제 설정(`live_settings.krx_prefer_hogaplay`)에서 온다. 설정이 로딩 중이면
// `useOrderflowSourcePref()` 가 undefined 를 주고 쿼리가 비활성화되는데(콜드 마운트 차트
// 스왑 방지), 이 파일이 보는 것은 그 게이트가 아니므로 해소된 기본값으로 고정한다.
// 게이트 자체는 sourcePreference.test.ts 가 검증한다.
vi.mock("../state/sourcePreference", async (orig) => ({
  ...(await orig<typeof import("../state/sourcePreference")>()),
  useOrderflowSourcePref: () => "kiwoom_live",
}));


// Mock the low-level fetch helper used by useSpot fetchers.
vi.mock('./client', async (orig) => {
  const actual = await orig<typeof import('./client')>();
  return {
    ...actual,
    apiGet: vi.fn(async (url: string) => {
      if (url.includes('/api/orderbook')) {
        return { snapshot: { ts_ms: 1, asks: [], bids: [] }, available_from: null, source: 'hogaplay' };
      }
      throw new Error('unexpected url: ' + url);
    }),
  };
});

import { apiGet } from './client';

// ─── 렌더 헬퍼 ────────────────────────────────────────────────────────────────

/**
 * `QueryClientProvider` 로 감싼 `renderHook`.
 *
 * 세 훅이 `useEffectiveVenue` → `capture/useSymbols`(react-query)를 타므로
 * provider 없이는 렌더가 던진다. 심볼 마스터는 **항상 시딩한다** — 안 그러면
 * `useSymbols` 가 실제로 `/api/symbols/all` 을 fetch 해서 apiGet 호출 횟수를
 * 세는 아래 단언들이 어긋난다(`seedSymbolMaster` docstring 이 같은 함정을 설명).
 *
 * `symbols` 기본값은 빈 배열 = **전 코드 "모름"**. 모름은 강등하지 않으므로
 * (`effectiveLiveVenue`) 해석이 항등이 되고, 해석 도입 이전 케이스들이 그대로
 * 유효하다. 코드별 해석을 보는 테스트만 `symbolHit(code, nxt)` 을 실어 넘긴다.
 *
 * QueryClient 는 호출마다 새로 만든다 — 캐시가 테스트 간에 새면 한 테스트의
 * 시딩이 다른 테스트의 "모름" 전제를 덮는다.
 */
function renderSpotHook<R, P = undefined>(
  cb: (props: P) => R,
  opts?: { initialProps?: P; symbols?: SymbolHit[] },
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedSymbolMaster(qc, opts?.symbols ?? []);
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
  return renderHook(cb, { wrapper, initialProps: opts?.initialProps as P });
}

/** NXT 미상장 종목(실측 003490 대한항공, `nxt_enabled=false`). */
const NXT_UNLISTED = '003490';
/** NXT 상장 종목(실측 000100 유한양행, `nxt_enabled=true`). */
const NXT_LISTED = '000100';

// ─── Task 10: useLiveOrderbookAtCursor ───────────────────────────────────────

describe('useLiveOrderbookAtCursor', () => {
  beforeEach(() => {
    useLiveCursorStore.getState().resetCursor();
    (apiGet as unknown as ReturnType<typeof vi.fn>).mockClear();
    (apiGet as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (url.includes('/api/orderbook')) {
        return { snapshot: { ts_ms: 1, asks: [], bids: [] }, available_from: null, source: 'hogaplay' };
      }
      throw new Error('unexpected url: ' + url);
    });
  });

  it('returns undefined and does not fetch when cursorMs is null', async () => {
    const { result } = renderSpotHook(() =>
      useLiveOrderbookAtCursor({ code: '005930', timeframe: '1m', venue: 'KRX' }),
    );
    expect(result.current).toBeUndefined();
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('waits for sidebarCursorMs instead of immediate cursorMs', async () => {
    renderSpotHook(() =>
      useLiveOrderbookAtCursor({ code: '005930', timeframe: '1m', venue: 'KRX' }),
    );

    act(() => useLiveCursorStore.getState().setCursor(1_779_930_001_234));
    expect(apiGet).not.toHaveBeenCalled();

    act(() => useLiveCursorStore.getState().setSidebarCursor(1_779_930_000_000));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    const url = (apiGet as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain('/api/orderbook');
    expect(url).toContain('date=20260528');
    expect(url).toContain('t=1779930000000');
  });

  it('fetches once when sidebarCursorMs becomes set', async () => {
    const { result, rerender } = renderSpotHook(() =>
      useLiveOrderbookAtCursor({ code: '005930', timeframe: '1m', venue: 'KRX' }),
    );
    act(() => {
      useLiveCursorStore.getState().setSidebarCursor(1_779_930_000_000);  // 2026-05-28 10:00:00 KST, exact 1m boundary
    });
    rerender();
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    const url = (apiGet as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain('/api/orderbook');
    expect(url).toContain('code=005930');
    expect(url).toContain('date=20260528');
    expect(url).toContain('t=1779930000000');
    expect(url).toContain('bucket_ms=60000');
    expect(url).toContain('source_pref=kiwoom_live');
    // venue 는 백엔드 필수 파라미터다(ADR-0140) — 빠지면 라우트가 422 를 내고
    // 10호가 창이 호버 내내 "호가 데이터 없음" 으로 남는다. 실제로 그렇게
    // 깨져 있었다(이 훅만 venue 전파에서 누락).
    expect(url).toContain('venue=KRX');
    // T14b: result is LiveOrderbookSpot, assert via .snapshot
    await waitFor(() => expect(result.current?.snapshot).toBeDefined());
  });

  it('venue change reissues the query', async () => {
    const { rerender } = renderSpotHook(
      ({ venue }: { venue: LiveVenueOption }) =>
        useLiveOrderbookAtCursor({ code: '005930', timeframe: '1m', venue }),
      { initialProps: { venue: 'KRX' as LiveVenueOption } },
    );
    act(() => useLiveCursorStore.getState().setSidebarCursor(1_779_930_000_000));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    rerender({ venue: 'UN' });
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    const url = (apiGet as ReturnType<typeof vi.fn>).mock.calls[1][0] as string;
    expect(url).toContain('venue=UN');
  });

  it('client-side bucket alignment collapses within-minute hover to one fetch', async () => {
    renderSpotHook(() =>
      useLiveOrderbookAtCursor({ code: '005930', timeframe: '1m', venue: 'KRX' }),
    );
    act(() => useLiveCursorStore.getState().setSidebarCursor(1_779_930_000_000));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    act(() => useLiveCursorStore.getState().setSidebarCursor(1_779_930_001_234));  // same minute
    act(() => useLiveCursorStore.getState().setSidebarCursor(1_779_930_029_999));  // same minute
    expect(apiGet).toHaveBeenCalledTimes(1);  // bucket-aligned: same key, LRU hit
  });

  it('hover on past-date candle uses date derived from cursorMs (regression guard)', async () => {
    // Simulates hovering on a 2026-04-15 candle in scroll-back mode.
    // cursorMs = 2026-04-15 10:30:00 KST (UTC 01:30:00) = 1776216600000
    // unixMsToKSTDate should yield '20260415', NOT today.
    const pastDayCursorMs = 1776216600000; // 2026-04-15 10:30:00 KST (exact 1m boundary)
    (apiGet as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (url.includes('/api/orderbook')) {
        return { snapshot: null, available_from: null, source: 'hogaplay' };
      }
      throw new Error('unexpected url: ' + url);
    });
    renderSpotHook(() =>
      useLiveOrderbookAtCursor({ code: '005930', timeframe: '1m', venue: 'KRX' }),
    );
    act(() => useLiveCursorStore.getState().setSidebarCursor(pastDayCursorMs));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    const url = (apiGet as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain('date=20260415');
    expect(url).not.toContain('date=20260528');  // must NOT be today
  });
});

// ─── Task 12: useLiveBrokersAtCursor ─────────────────────────────────────────

describe('useLiveBrokersAtCursor', () => {
  beforeEach(() => {
    useLiveCursorStore.getState().resetCursor();
    (apiGet as unknown as ReturnType<typeof vi.fn>).mockClear();
    (apiGet as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (url.includes('/api/brokers/series')) {
        return { date: '20260528', brokers: [], source: 'hogaplay' };
      }
      throw new Error('unexpected url: ' + url);
    });
  });

  it('does not fetch when cursorMs null', () => {
    renderSpotHook(() => useLiveBrokersAtCursor({ code: '005930', timeframe: '1m', venue: 'KRX' }));
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('does not fetch on calendar timeframe (D/W/M) even with cursor set', async () => {
    // LiveChartRoot publishes cursorMs on all frames (D/W/M included), but
    // /api/brokers/series has no per-cursor parquet there (ADR-0044). The
    // timeframe gate (null on calendar frames) keeps the fetch dormant — the
    // isSpot gate in LiveSidebar only suppresses display, not the fetch.
    renderSpotHook(() => useLiveBrokersAtCursor({ code: '005930', timeframe: null, venue: 'KRX' }));
    act(() => useLiveCursorStore.getState().setSidebarCursor(1_779_930_000_000));
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('fetches once when sidebarCursorMs set, key independent of sidebarCursorMs value', async () => {
    renderSpotHook(() => useLiveBrokersAtCursor({ code: '005930', timeframe: '1m', venue: 'KRX' }));
    act(() => useLiveCursorStore.getState().setSidebarCursor(1_779_930_000_000));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    // Moving cursor within the same day must not refetch — the day series
    // is whole-day; the sidebar projects per-row net at cursor client-side.
    act(() => useLiveCursorStore.getState().setSidebarCursor(1_779_930_840_000));  // +14 min, same day
    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it('sends the required venue param and reissues when it changes', async () => {
    // venue 누락 = 백엔드 422(ADR-0140) → 거래원 창이 호버 내내 "거래원 정보
    // 없음". 회귀 가드다.
    const { rerender } = renderSpotHook(
      ({ venue }: { venue: LiveVenueOption }) =>
        useLiveBrokersAtCursor({ code: '005930', timeframe: '1m', venue }),
      { initialProps: { venue: 'KRX' as LiveVenueOption } },
    );
    act(() => useLiveCursorStore.getState().setSidebarCursor(1_779_930_000_000));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    expect((apiGet as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('venue=KRX');
    rerender({ venue: 'UN' });
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
    expect((apiGet as ReturnType<typeof vi.fn>).mock.calls[1][0]).toContain('venue=UN');
  });
});

// ─── 커서 ↔ latest 캐시 공유 (중복 발사 회귀 가드) ────────────────────────────

/**
 * 두 거래원 훅은 **같은 캐시 키**를 써야 한다.
 *
 * 막는 방향: 두 훅이 같은 (code, date, source_pref, venue) 를 볼 때 요청이 **2건
 * 이상** 나가는 쪽. 예전엔 각자 `useSpot` 위에 있었고 그 LRU 는 훅 인스턴스별이라
 * (그 파일의 계약: "Different consumers do not share state") dedup 이 아예 없었다 —
 * 커서 스코프가 `minute-cursor` ↔ `inactive` 로 한 번 뒤집히기만 해도 바이트 단위로
 * 같은 URL 이 두 번 나갔다(실측 2026-08-19 `/live` 종목 전환: 58ms·402ms 2벌).
 *
 * 못 보는 것: 날짜가 **다를** 때는 키가 갈리는 게 맞으므로 이 가드가 아무 말도
 * 하지 않는다. 그리고 이건 캐시 공유만 본다 — 실제 화면에서 어느 훅이 깨어 있는지는
 * `resolveCursorDetailScope` 의 몫이라 `cursorDetailResolver.test.ts` 가 본다.
 */
describe('거래원 훅 캐시 공유', () => {
  /** 커서와 "오늘" 이 같은 날짜를 가리키게 하려고 시계를 고정한다.
   *  2026-05-28 10:00 KST — 다른 스위트가 쓰는 값과 같아 date=20260528 이다. */
  const TODAY_MS = 1_779_930_000_000;

  beforeEach(() => {
    useLiveCursorStore.getState().resetCursor();
    (apiGet as unknown as ReturnType<typeof vi.fn>).mockClear();
    (apiGet as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (url.includes('/api/brokers/series')) {
        return { date: '20260528', brokers: [], source: 'hogaplay' };
      }
      throw new Error('unexpected url: ' + url);
    });
  });

  it('커서 훅과 latest 훅이 같은 날짜를 보면 요청은 1건이다', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(TODAY_MS);
    try {
      const urls = (): string[] =>
        (apiGet as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);

      renderSpotHook(() => {
        // 피험군 — 실제 BrokerWindow 가 스코프 플립 순간에 만드는 조합이다.
        useLiveBrokersAtCursor({ code: '005930', timeframe: '1m', venue: 'KRX' });
        useLiveBrokersToday('005930', 'KRX');
        // 대조군 — 커서 훅만 있는 다른 종목. latest 훅은 마운트 즉시 쏘지만 커서
        // 훅은 커서 세팅 + 30ms 디바운스 뒤라, 그냥 세면 "아직 안 왔을 뿐" 인
        // 상태를 통과로 읽는 **위양성**이 된다. 대조군의 요청 도착이 곧 "피험군
        // 커서 훅의 디바운스도 이미 풀렸다" 는 배리어다 — 벽시계로 안 기다린다.
        useLiveBrokersAtCursor({ code: '000660', timeframe: '1m', venue: 'KRX' });
      });

      act(() => useLiveCursorStore.getState().setSidebarCursor(TODAY_MS));
      await waitFor(() =>
        expect(urls().filter((u) => u.includes('code=000660'))).toHaveLength(1),
      );
      expect(urls().filter((u) => u.includes('code=005930'))).toHaveLength(1);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

// ─── 코드별 유효 venue 해석 (#1209 후속) ──────────────────────────────────────

/**
 * 세 스팟 훅은 **선택값이 아니라 해석한 venue** 로 조회한다.
 *
 * 고치기 전에는 선택값을 그대로 백엔드에 보냈고, NXT 미상장 종목에 통합(UN)을
 * 고르면 거래원 창과 호가 스팟이 통째로 비었다 — 백엔드가 그 조합의 파케이
 * 디렉터리를 **만든 적이 없기 때문**이다(`live/coverage.subscription_venues` 가
 * 미상장 종목에 `("KRX",)` 만 준다). 부재는 500 이 아니라 빈 200 이라 증상이
 * 조용하다. 실측 2026-08-07 dev :8000, 003490(`nxt_enabled=false`):
 * `/api/brokers/series` 가 KRX → 16 브로커 / 14,583 점, UN → **0**.
 *
 * 표시층(BrokerTrajectoryTable)과 `useLiveSeries`·ChartWindow 는 이미 해석된
 * 값을 쓰고 있었다. 즉 이 가드는 **훅이 그 규칙에서 이탈하는 방향**을 막는다 —
 * 백엔드가 UN 을 흡수하기 시작해도(그럴 계획 없음) 이 단언은 계속 유효하다.
 */
describe('코드별 유효 venue 해석', () => {
  beforeEach(() => {
    useLiveCursorStore.getState().resetCursor();
    (apiGet as unknown as ReturnType<typeof vi.fn>).mockClear();
    (apiGet as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (url.includes('/api/brokers/series')) {
        return { date: '20260528', brokers: [], source: 'kiwoom_live' };
      }
      if (url.includes('/api/orderbook')) {
        return { snapshot: { ts_ms: 1, asks: [], bids: [] }, available_from: null, source: 'kiwoom_live' };
      }
      throw new Error('unexpected url: ' + url);
    });
  });

  /** 지금까지 apiGet 이 받은 URL 전량. */
  const urls = (): string[] =>
    (apiGet as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);

  /** 커서 훅을 깨우고 첫 요청 URL 을 돌려준다. */
  async function firstUrl(): Promise<string> {
    act(() => useLiveCursorStore.getState().setSidebarCursor(1_779_930_000_000));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    return urls()[0];
  }

  it('useLiveBrokersAtCursor: UN + NXT 미상장 → KRX 로 강등해 조회한다', async () => {
    renderSpotHook(
      () => useLiveBrokersAtCursor({ code: NXT_UNLISTED, timeframe: '1m', venue: 'UN' }),
      { symbols: [symbolHit(NXT_UNLISTED, false)] },
    );
    const url = await firstUrl();
    expect(url).toContain('venue=KRX');
    expect(url).not.toContain('venue=UN');
  });

  it('useLiveBrokersAtCursor: UN + NXT 상장 → UN 그대로', async () => {
    renderSpotHook(
      () => useLiveBrokersAtCursor({ code: NXT_LISTED, timeframe: '1m', venue: 'UN' }),
      { symbols: [symbolHit(NXT_LISTED, true)] },
    );
    expect(await firstUrl()).toContain('venue=UN');
  });

  it('useLiveBrokersAtCursor: UN + 마스터에 없는 코드(모름) → UN 그대로', async () => {
    // 모름을 강등하면 백엔드가 fail-open 으로 실제 구독한 UN 데이터를 버린다
    // (`subscription_venues` 의 "모름은 미상장이 아니다"). 심볼 마스터 도착 전
    // 창이 이 경로다.
    renderSpotHook(() =>
      useLiveBrokersAtCursor({ code: NXT_UNLISTED, timeframe: '1m', venue: 'UN' }),
    );
    expect(await firstUrl()).toContain('venue=UN');
  });

  it('useLiveBrokersAtCursor: NXT + NXT 미상장 → NXT 그대로(강등은 UN 에만)', async () => {
    // #1132 — 미상장 종목에 NXT 를 고른 것은 명시적 선택이고, 그때 빈 창은
    // 정직한 표시다. 여기서 KRX 로 바꾸면 사용자가 요청하지 않은 시장을 보여준다.
    renderSpotHook(
      () => useLiveBrokersAtCursor({ code: NXT_UNLISTED, timeframe: '1m', venue: 'NXT' }),
      { symbols: [symbolHit(NXT_UNLISTED, false)] },
    );
    expect(await firstUrl()).toContain('venue=NXT');
  });

  it('캐시 키도 해석된 값을 쓴다 — 미상장 종목에서 KRX↔UN 토글이 재요청을 안 낸다', async () => {
    // useSpot 의 LRU 는 훅 인스턴스별이라(useSpot.ts) 같은 인스턴스 안의 토글은
    // 키가 같을 때만 캐시 히트다. 키가 선택값으로 잡혀 있으면 KRX 와 UN 이 서로
    // 다른 키가 되어 **같은 응답을 두 벌 받는다** — URL 만 고치고 키를 놓치면
    // 이 단언이 깨져야 한다.
    //
    // ⚠ "rerender 직후 호출 횟수를 즉시 재는" 판은 **위양성**이다. useSpot 이
    // 30ms 디바운스 뒤에 fetch 하므로 그 시점엔 무엇을 넣어도 1 이다(첫 판이
    // 실제로 red-check 에서 안 빨개졌다). 그래서 **대조군을 같은 렌더에 함께**
    // 마운트한다: 두 훅의 디바운스 타이머는 같은 커밋에서 같은 시각에 걸리므로,
    // 대조군의 요청이 도착했다는 것이 곧 "날 거였으면 이미 났다"는 배리어다 —
    // 벽시계 상수로 기다리지 않는다.
    const { rerender } = renderSpotHook(
      ({ venue }: { venue: LiveVenueOption }) => {
        // 피험군: 미상장 → 해석 후 KRX·UN 모두 KRX. 키가 안 바뀌어야 한다.
        useLiveBrokersAtCursor({ code: NXT_UNLISTED, timeframe: '1m', venue });
        // 대조군: 상장 → UN 이 UN 으로 남아 키가 갈리고 반드시 재요청한다.
        useLiveBrokersAtCursor({ code: NXT_LISTED, timeframe: '1m', venue });
      },
      {
        initialProps: { venue: 'KRX' as LiveVenueOption },
        symbols: [symbolHit(NXT_UNLISTED, false), symbolHit(NXT_LISTED, true)],
      },
    );
    act(() => useLiveCursorStore.getState().setSidebarCursor(1_779_930_000_000));
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));

    rerender({ venue: 'UN' });
    await waitFor(() =>
      expect(urls().filter((u) => u.includes(`code=${NXT_LISTED}`))).toHaveLength(2),
    );
    // 배리어 통과 시점 — 미상장 종목은 최초 KRX 1건뿐이어야 한다.
    expect(urls().filter((u) => u.includes(`code=${NXT_UNLISTED}`))).toHaveLength(1);
  });

  it('useLiveOrderbookAtCursor: UN + NXT 미상장 → KRX 로 강등해 조회한다', async () => {
    // BrokerWindow 와 같은 결함이 BookWindow 스팟 경로에도 있었다. 실측 동일
    // 종목·같은 날: `/api/orderbook` 이 KRX → 스냅샷, UN → `null`.
    renderSpotHook(
      () => useLiveOrderbookAtCursor({ code: NXT_UNLISTED, timeframe: '1m', venue: 'UN' }),
      { symbols: [symbolHit(NXT_UNLISTED, false)] },
    );
    const url = await firstUrl();
    expect(url).toContain('/api/orderbook');
    expect(url).toContain('venue=KRX');
  });

  it('useLiveBrokersToday: UN + NXT 미상장 → KRX 로 강등해 조회한다', async () => {
    // latest 모드(커서 없음)의 경로 — `/live` 를 열자마자 보이는 기본 상태라
    // 셋 중 사용자에게 가장 먼저 드러나는 창이다.
    renderSpotHook(() => useLiveBrokersToday(NXT_UNLISTED, 'UN'), {
      symbols: [symbolHit(NXT_UNLISTED, false)],
    });
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    const url = (apiGet as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain('/api/brokers/series');
    expect(url).toContain('venue=KRX');
  });

  it('useLiveBrokersToday: UN + NXT 상장 → UN 그대로', async () => {
    renderSpotHook(() => useLiveBrokersToday(NXT_LISTED, 'UN'), {
      symbols: [symbolHit(NXT_LISTED, true)],
    });
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    expect((apiGet as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('venue=UN');
  });
});
