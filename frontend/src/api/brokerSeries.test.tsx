/**
 * Tests for brokerSeries.ts — `/live` 커서·latest 와 `/study` 가 공유하는 하루치
 * 거래원 궤적 조회.
 *
 * `apiCall` 이 아니라 **`apiGet` 을 모킹한다.** `apiGet` 은 같은 모듈 안에서
 * `apiCall` 을 부르는 얇은 별칭이라, `apiCall` 에 스파이를 걸면 모듈 지역 바인딩을
 * 타고 지나가 버려 아무것도 못 잡는다(옛 판이 그 함정에 있었다).
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';

import { useBrokerSeriesForDay } from './brokerSeries';
import { seedSymbolMaster, symbolHit } from '../live/seedSymbolMaster';
import type { BrokerSeriesEntry, BrokerSeriesResponse, SymbolHit } from './types';

vi.mock('./client', async (orig) => {
  const actual = await orig<typeof import('./client')>();
  return { ...actual, apiGet: vi.fn() };
});

import { apiGet } from './client';

const ENTRY: BrokerSeriesEntry = {
  broker: 'JP모간',
  final_net: 79523,
  dominant_side: 'buy',
  points: [{ ts_ms: 1_747_958_400_000, net: 79523 }],
};

const RESPONSE: BrokerSeriesResponse = {
  date: '20260519',
  brokers: [ENTRY],
  source: 'hogaplay',
};

/** NXT 미상장 종목(실측 003490 대한항공, `nxt_enabled=false`). */
const NXT_UNLISTED = '003490';

const mockApiGet = apiGet as unknown as ReturnType<typeof vi.fn>;

/** 지금까지 apiGet 이 받은 URL 전량. */
const urls = (): string[] => mockApiGet.mock.calls.map((c) => c[0] as string);

/**
 * `QueryClientProvider` 로 감싼 `renderHook`.
 *
 * 훅이 `useEffectiveVenue` → `capture/useSymbols`(react-query)를 타므로 provider
 * 없이는 렌더가 던진다. 심볼 마스터는 **항상 시딩한다** — 안 그러면 `useSymbols`
 * 가 실제로 `/api/symbols/all` 을 fetch 해서 호출 횟수 단언이 어긋난다.
 * 기본값 빈 배열 = 전 코드 "모름" 이고, 모름은 강등하지 않으므로 해석이 항등이다.
 */
function renderBrokerHook<R>(
  cb: () => R,
  opts?: { symbols?: SymbolHit[]; client?: QueryClient },
) {
  const qc =
    opts?.client ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedSymbolMaster(qc, opts?.symbols ?? []);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(cb, { wrapper });
}

describe('useBrokerSeriesForDay', () => {
  beforeEach(() => {
    mockApiGet.mockReset();
    mockApiGet.mockResolvedValue(RESPONSE);
  });

  it('code 가 null 이면 조회하지 않는다', () => {
    const { result } = renderBrokerHook(() =>
      useBrokerSeriesForDay({
        code: null,
        date: '20260519',
        sourcePref: 'hogaplay',
        venue: 'KRX',
        liveRefreshMs: null,
      }),
    );
    expect(result.current).toBeUndefined();
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('date 가 null 이면 조회하지 않는다', () => {
    renderBrokerHook(() =>
      useBrokerSeriesForDay({
        code: '005930',
        date: null,
        sourcePref: 'hogaplay',
        venue: 'KRX',
        liveRefreshMs: null,
      }),
    );
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('sourcePref 가 미해소(undefined)면 조회하지 않는다', () => {
    // 설정(`live_settings.krx_prefer_hogaplay`)이 로딩 중인 구간. 기본값으로 한 번
    // 받고 해소된 뒤 다시 받으면 콜드 마운트에서 화면이 스왑된다.
    renderBrokerHook(() =>
      useBrokerSeriesForDay({
        code: '005930',
        date: '20260519',
        sourcePref: undefined,
        venue: 'KRX',
        liveRefreshMs: null,
      }),
    );
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('source_pref 를 포함한 쿼리스트링으로 조회하고 brokers 만 돌려준다', async () => {
    // ⚠ `source_pref` 는 **회귀 가드다.** 이 자리에 있던 옛 훅(useBrokerSeriesForDay
    // 구판)은 이 파라미터를 빠뜨린 채 소비자 0 으로 방치돼 있었다 — 그대로 살려
    // 썼다면 백엔드가 선호 소스를 못 받아 조용히 다른 소스로 답했을 것이다.
    const { result } = renderBrokerHook(() =>
      useBrokerSeriesForDay({
        code: '005930',
        date: '20260519',
        sourcePref: 'hogaplay',
        venue: 'KRX',
        liveRefreshMs: null,
      }),
    );
    await waitFor(() => expect(result.current).toEqual([ENTRY]));
    expect(urls()).toEqual([
      '/api/brokers/series?code=005930&date=20260519&source_pref=hogaplay&venue=KRX',
    ]);
  });

  it('선택값이 아니라 해석한 venue 로 조회한다 — UN + NXT 미상장 → KRX', async () => {
    // 백엔드는 미상장 종목의 `UN` 파케이를 만든 적이 없고, 부재를 500 이 아니라
    // **빈 200** 으로 답한다(#1209 후속). 해석을 빠뜨리면 창이 조용히 빈다.
    renderBrokerHook(
      () =>
        useBrokerSeriesForDay({
          code: NXT_UNLISTED,
          date: '20260519',
          sourcePref: 'hogaplay',
          venue: 'UN',
          liveRefreshMs: null,
        }),
      { symbols: [symbolHit(NXT_UNLISTED, false)] },
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    expect(urls()[0]).toContain('venue=KRX');
    expect(urls()[0]).not.toContain('venue=UN');
  });

  it('liveRefreshMs=null(과거 날짜)이면 재렌더에도 다시 받지 않는다', async () => {
    const { rerender } = renderBrokerHook(() =>
      useBrokerSeriesForDay({
        code: '005930',
        date: '20260519',
        sourcePref: 'hogaplay',
        venue: 'KRX',
        liveRefreshMs: null,
      }),
    );
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
    rerender();
    rerender();
    expect(apiGet).toHaveBeenCalledTimes(1);   // staleTime: Infinity
  });

  it('같은 파라미터의 소비자 둘은 요청을 하나만 낸다', async () => {
    // 이 훅이 존재하는 이유. 소비 표면이 둘(커서·latest)이고 예전엔 각자
    // 훅 인스턴스별 LRU 를 들고 있어 dedup 이 아예 없었다.
    renderBrokerHook(() => {
      useBrokerSeriesForDay({
        code: '005930',
        date: '20260519',
        sourcePref: 'hogaplay',
        venue: 'KRX',
        liveRefreshMs: null,
      });
      useBrokerSeriesForDay({
        code: '005930',
        date: '20260519',
        sourcePref: 'hogaplay',
        venue: 'KRX',
        liveRefreshMs: 60_000,
      });
    });
    await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
  });
});
