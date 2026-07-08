/** /study 복기뷰 분봉 로드 × ADR-0091 예산 상호작용 회귀 가드.
 *
 * useStudyReferenceBundle이 /live의 청크 워크백 훅(useLivePastCandles)을
 * 재사용하므로, 저장 기간이 백엔드 fetch 예산(12거래일)을 넘어도 (a) 15일
 * 청크로 나뉘어 seed까지 로드되고, (b) fetch_budget_exhausted 부분 응답이
 * 델타 기준에 박제되지 않아 자가 회복된다.
 *
 * 청크 머신·blocking 비박제의 일반 계약은 api/livePastCandles.test.tsx가
 * 검증한다(:72 워크백, :263 비박제, :413 budget=blocking). 이 파일은 그
 * 계약을 복기뷰의 실제 저장 기간 값(예산 초과 30캘린더일)으로 잠근다 —
 * 훅 배선(useStudyReferenceBundle.test.tsx)과 함께 study 경로 회귀를 막는다.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLivePastCandles, type LivePastCandlesResponse } from '../api/livePastCandles';
import * as client from '../api/client';

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

// 복기뷰 저장 기간: 30캘린더일(예산 12거래일 초과) → 15일 청크 2개로 분할.
const STUDY_FROM = '20260608';
const STUDY_TO = '20260707';

describe('study 분봉 청크 워크백 (ADR-0091 예산 상호작용)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('예산 초과 저장 기간(30일)이 15일 청크 2개로 seed까지 로드된다', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockImplementation(async (url: string) => {
      const params = new URLSearchParams(url.split('?')[1]);
      return {
        code: params.get('code')!, from: params.get('from')!, to: params.get('to')!,
        venue: 'KRX', candles: [], cached_dates: [], fresh_dates: [], data_warnings: [],
      } satisfies LivePastCandlesResponse;
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useLivePastCandles('005930', STUDY_FROM, STUDY_TO, 'KRX'), {
      wrapper: wrap(qc),
    });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2), { timeout: 3000 });
    const urls = spy.mock.calls.map((c) => c[0] as string);
    // 첫 청크는 최신 15일, 둘째 청크가 seed(STUDY_FROM)까지 이어받는다.
    expect(urls[0]).toContain('from=20260623&to=20260707');
    expect(urls[1]).toContain(`from=${STUDY_FROM}&to=20260622`);
  });

  it('첫 청크의 fetch_budget_exhausted 부분 응답은 박제되지 않고 회복된다', async () => {
    const seed: LivePastCandlesResponse = {
      code: '005930', from: '20260623', to: STUDY_TO, venue: 'KRX',
      candles: [{ t_ms: 2, open: 1, high: 1, low: 1, close: 102, volume: 1 }],
      cached_dates: [], fresh_dates: ['20260623'], data_warnings: [],
    };
    const budgetHit: LivePastCandlesResponse = {
      code: '005930', from: STUDY_FROM, to: '20260622', venue: 'KRX',
      candles: [], cached_dates: [], fresh_dates: [],
      data_warnings: [{ date: STUDY_FROM, reason: 'fetch_budget_exhausted', msg: 'deferred' }],
    };
    const recovered: LivePastCandlesResponse = {
      ...budgetHit,
      candles: [{ t_ms: 1, open: 1, high: 1, low: 1, close: 101, volume: 1 }],
      fresh_dates: [STUDY_FROM],
      data_warnings: [],
    };
    let deltaCalls = 0;
    vi.spyOn(client, 'apiCall').mockImplementation((url) => {
      if (url.includes(`from=${STUDY_FROM}&to=20260622`)) {
        deltaCalls += 1;
        return Promise.resolve(deltaCalls === 1 ? budgetHit : recovered);
      }
      return Promise.resolve(seed);
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, rerender } = renderHook(
      ({ from }: { from: string }) => useLivePastCandles('005930', from, STUDY_TO, 'KRX'),
      { wrapper: wrap(qc), initialProps: { from: '20260623' } },
    );
    await waitFor(() => expect(result.current.data?.from).toBe('20260623'));

    // seed까지 확장 → 예산 유예(budget) 응답이 이번 렌더에만 서빙되고 박제 안 됨.
    rerender({ from: STUDY_FROM });
    await waitFor(() => expect(deltaCalls).toBe(1));
    await waitFor(() =>
      expect(result.current.data?.candles.map((c) => c.close)).toEqual([102]));

    // 서버 회복: 무효화가 유예 창을 재요청해 좌측 구간이 채워진다.
    rerender({ from: STUDY_FROM });
    await qc.invalidateQueries();
    await waitFor(() => expect(deltaCalls).toBe(2));
    await waitFor(() =>
      expect(result.current.data?.candles.map((c) => c.close)).toEqual([101, 102]));
  });
});
