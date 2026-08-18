import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as api from '../api/watchlist';

// AddForm 을 **발화 버튼으로 대체**한다 — 이 파일의 관심사는 pane 쪽 계약
// (하이라이트 · 스크롤 · 해제)이지 중복 판정이 아니다. 판정은
// `WatchlistAddForm.test.tsx` 가 콜백 발화로 따로 잡는다(축 분리).
//
// 별도 파일인 이유: 이 mock 은 AddForm 의 실제 렌더를 보는 기존 테스트
// (예: layout inline 단언)와 공존할 수 없다. `WatchlistDrawer.drag/.memo/.insertSymbol`
// 과 같은 관용구다.
vi.mock('./WatchlistAddForm', () => ({
  WatchlistAddForm: ({ onDuplicate }: { onDuplicate?: (code: string) => void }) => (
    <button type="button" onClick={() => onDuplicate?.('005930')}>중복 발화</button>
  ),
}));

import { WatchlistEntryPane } from './WatchlistEntryPane';

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const DATA = {
  folders: [{ id: 'f_a', name: '스윙', order: 0 }, { id: 'f_b', name: '장기', order: 1 }],
  entries: [
    { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_a', order: 0 },
    { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_a', order: 1 },
    { code: '035420', name: 'NAVER', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_b', order: 0 },
  ],
  memos: [],
  next_run_at_ms: 0,
};

const newQc = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe('WatchlistEntryPane — 중복 종목 안내', () => {
  beforeEach(() => {
    cleanup();
    vi.restoreAllMocks();
    // jsdom 에는 scrollIntoView 가 없다(구현부도 `?.` 로 호출한다).
    Element.prototype.scrollIntoView = vi.fn();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('지목된 행을 하이라이트하고 그 자리로 스크롤한다', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
    render(<WatchlistEntryPane selected="f_a" />, { wrapper: wrap(newQc()) });
    await screen.findByText('삼성전자');

    expect(screen.getByTestId('edit-row-005930').className).not.toMatch(/row-flash/);

    fireEvent.click(screen.getByText('중복 발화'));

    await waitFor(() =>
      expect(screen.getByTestId('edit-row-005930').className).toMatch(/row-flash/));
    // 하이라이트만으로는 부족하다 — 그 행이 화면 밖이면 아무것도 안 보인다.
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    // 지목되지 않은 행은 그대로다.
    expect(screen.getByTestId('edit-row-000660').className).not.toMatch(/row-flash/);
  });

  it('잠시 뒤 스스로 꺼진다', async () => {
    // ⚠ fake timers 는 **타이머가 걸리기 전에** 켜야 한다 — 실제 타이머로 예약된 뒤에
    // 켜면 advanceTimersByTime 이 그걸 못 건드린다(실측: 그래서 처음에 실패했다).
    // `shouldAdvanceTime` 은 react-query 등 다른 async 가 멈추지 않게 한다.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
    render(<WatchlistEntryPane selected="f_a" />, { wrapper: wrap(newQc()) });
    await screen.findByText('삼성전자');
    fireEvent.click(screen.getByText('중복 발화'));
    await waitFor(() =>
      expect(screen.getByTestId('edit-row-005930').className).toMatch(/row-flash/));

    // 벽시계로 기다리지 않는다 — 그런 테스트는 머신 부하에서 흔들린다.
    act(() => { vi.advanceTimersByTime(3000); });

    await waitFor(() =>
      expect(screen.getByTestId('edit-row-005930').className).not.toMatch(/row-flash/));
  });

  it('폴더를 바꾸면 즉시 꺼진다 — 그 행은 더 이상 보이지 않는다', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
    const { rerender } = render(<WatchlistEntryPane selected="f_a" />, { wrapper: wrap(newQc()) });
    await screen.findByText('삼성전자');
    fireEvent.click(screen.getByText('중복 발화'));
    await waitFor(() =>
      expect(screen.getByTestId('edit-row-005930').className).toMatch(/row-flash/));

    rerender(<WatchlistEntryPane selected="f_b" />);
    rerender(<WatchlistEntryPane selected="f_a" />);

    await waitFor(() =>
      expect(screen.getByTestId('edit-row-005930').className).not.toMatch(/row-flash/));
  });
});
