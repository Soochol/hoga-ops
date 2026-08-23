import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/studyViews', () => ({ getStudyView: vi.fn() }));
vi.mock('../live/liveNavigate', () => ({ activateLiveCode: vi.fn() }));

import { getStudyView, type StudyViewListRow } from '../api/studyViews';
import { activateLiveCode } from '../live/liveNavigate';
import { useLivePageStore } from '../state/livePage';
import { useSavedRangeDeepLink } from './useSavedRangeDeepLink';

const ROW: StudyViewListRow = {
  schema_version: 2,
  id: 'v-1',
  name: '6월 급등 구간',
  code: '005930',
  label: '삼성전자',
  timeframe: '5m',
  range: { from_date: '20260622', to_date: '20260626', from_ms: 1_000, to_ms: 2_000 },
  viewport: { right_edge_ms: 2_000, bar_span: 120, at_live_edge: false },
  memo: '',
  tags: [],
  created_at_ms: 0,
  updated_at_ms: 0,
};

/** `retry: false` 를 훅이 스스로 지정하므로 클라이언트 기본값은 비워 둔다 — 여기서
 *  다시 끄면 그 지정이 사라져도 테스트가 초록이라 가드가 죽는다. */
function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('useSavedRangeDeepLink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    act(() => useLivePageStore.getState().clearSavedRange());
  });

  it('seeds the live symbol and the saved-range slot from ?view=', async () => {
    vi.mocked(getStudyView).mockResolvedValue(ROW);
    const qc = new QueryClient();

    renderHook(() => useSavedRangeDeepLink('v-1'), { wrapper: wrap(qc) });

    await waitFor(() => expect(useLivePageStore.getState().savedRangeFocus).not.toBeNull());
    expect(getStudyView).toHaveBeenCalledWith('v-1');
    // 라벨까지 넘겨야 창 헤더가 `005930(005930)` 이 되지 않는다(`activateLiveCode` 의
    // `label ?? code` 폴백).
    expect(activateLiveCode).toHaveBeenCalledWith('005930', '삼성전자');
    expect(useLivePageStore.getState().savedRangeFocus).toEqual({
      viewId: 'v-1',
      code: '005930',
      label: '삼성전자',
      fromMs: 1_000,
      toMs: 2_000,
      fromDate: '20260622',
      toDate: '20260626',
      savedTimeframe: '5m',
      savedBarSpan: 120,
    });
  });

  it('does nothing without ?view=', async () => {
    const qc = new QueryClient();

    renderHook(() => useSavedRangeDeepLink(null), { wrapper: wrap(qc) });

    await act(async () => { await Promise.resolve(); });
    expect(getStudyView).not.toHaveBeenCalled();
    expect(activateLiveCode).not.toHaveBeenCalled();
    expect(useLivePageStore.getState().savedRangeFocus).toBeNull();
  });

  /**
   * ⚠ **이 테스트는 두 번 무력화될 뻔했다** — 둘 다 "아무 일도 안 일어났다" 가 아니라
   * "아무 일도 **일어날 수 없었다**" 를 재는 실패다.
   *
   *  1. 재렌더만으로는 부족하다. effect deps 가 `[viewId, data]` 라 같은 데이터로 다시
   *     그리면 effect 자체가 안 돈다. 가드가 일하는 순간은 **행이 갱신돼 data 의
   *     identity 가 바뀔 때**다(드로어에서 메모를 고치면 이 행도 새 객체가 된다).
   *  2. `setQueryData` 뒤 microtask flush(`await Promise.resolve()`)로는 옵저버가 안
   *     깨어난다 — 실측: 훅이 본 값이 `[undefined, 원본]` 에서 멈춘다. react-query 의
   *     알림은 마이크로태스크가 아니라 배치 스케줄러를 탄다.
   *
   * 그래서 **양성 대조**를 단언 안에 박아 둔다: 캐시 편집 뒤 훅이 실제로 다시 그려졌는지
   * (`renders`)를 먼저 기다린다. 그게 통과해야 아래 두 단언이 "기회가 있었는데 안 했다"
   * 를 의미한다.
   */
  it('seeds once — a saved-view edit does not drag the user back to the saved range', async () => {
    vi.mocked(getStudyView).mockResolvedValue(ROW);
    const qc = new QueryClient();
    const renders: number[] = [];

    renderHook(() => { renders.push(1); useSavedRangeDeepLink('v-1'); }, { wrapper: wrap(qc) });
    await waitFor(() => expect(useLivePageStore.getState().savedRangeFocus).not.toBeNull());

    // 사용자가 다른 종목을 눌러 슬롯이 풀린 뒤, 드로어에서 이 저장뷰의 메모를 고쳤다.
    act(() => useLivePageStore.getState().clearSavedRange());
    const rendersBefore = renders.length;
    act(() => { qc.setQueryData(['study-view', 'v-1'], { ...ROW, memo: '고친 메모' }); });
    await waitFor(() => expect(renders.length).toBeGreaterThan(rendersBefore));

    expect(useLivePageStore.getState().savedRangeFocus).toBeNull();
    expect(activateLiveCode).toHaveBeenCalledTimes(1);
  });

  it('lands on a plain /live when the saved view is gone (deleted bookmark)', async () => {
    vi.mocked(getStudyView).mockRejectedValue(Object.assign(new Error('404'), { status: 404 }));
    const qc = new QueryClient();

    renderHook(() => useSavedRangeDeepLink('v-gone'), { wrapper: wrap(qc) });

    // `retry: false` 를 재는 것은 **호출 횟수가 아니라 여기서 error 로 정착하는가**다.
    // 횟수 단언만으로는 아무것도 안 잡힌다(실측: `retry` 를 지워도 초록) — 재시도는
    // 백오프를 타서 테스트 창 안에 두 번째 호출이 아예 안 들어오기 때문이다. 기본값
    // (retry 3)이면 이 waitFor 가 1초 안에 error 에 못 닿아 실패한다.
    await waitFor(() => expect(qc.getQueryState(['study-view', 'v-gone'])?.status).toBe('error'));
    expect(getStudyView).toHaveBeenCalledTimes(1);
    expect(activateLiveCode).not.toHaveBeenCalled();
    expect(useLivePageStore.getState().savedRangeFocus).toBeNull();
  });
});
