import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastViewport } from '../ui/toast/ToastViewport';
import { ToastCard } from '../ui/toast/ToastCard';
import { transactWatchlistItems, type WatchlistFolderItemsChange } from '../api/watchlist';
import { useWatchlistTransfer } from './useWatchlistTransfer';
import { WatchlistTransferToast } from './WatchlistTransferToast';

vi.mock('../api/watchlist', () => ({ transactWatchlistItems: vi.fn() }));
const changes: WatchlistFolderItemsChange[] = [{
  folder_id: 'folder', before: [{ kind: 'code', code: '005930' }], after: [],
}];
function Panel() {
  const transfer = useWatchlistTransfer();
  return <div data-testid="panel">
    <button onClick={() => { void transfer.run(changes, '대원전선 → abcd · 가온전선 위로 이동'); }}>이동</button>
    <WatchlistTransferToast transfer={transfer} />
  </div>;
}
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  render(<QueryClientProvider client={client}>
    <ToastViewport><ToastCard visible>그림 1개 삭제됨</ToastCard></ToastViewport>
    <Panel />
  </QueryClientProvider>);
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(transactWatchlistItems).mockReset().mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('패널 밖 공용 토스트 영역에 표시하고 실행취소 및 자동 닫기를 제공한다', async () => {
  setup();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '이동' })); });
  const toast = screen.getByRole('status', { name: '종목 이동 안내' });
  expect(toast.parentElement).toBe(screen.getByText('그림 1개 삭제됨').parentElement);
  expect(within(screen.getByTestId('panel')).queryByRole('status')).toBeNull();
  expect(toast).toHaveClass('toast-card');
  expect(toast.querySelector('.toast-progress')).toHaveStyle({ animationDuration: '5000ms' });
  await act(async () => { fireEvent.click(within(toast).getByRole('button', { name: '실행취소' })); });
  expect(transactWatchlistItems).toHaveBeenLastCalledWith({ changes: [{
    folder_id: 'folder', before: [], after: changes[0].before,
  }] });
  expect(toast).toHaveTextContent('이동을 되돌렸습니다');
  act(() => { vi.advanceTimersByTime(5000); });
  expect(screen.queryByRole('status', { name: '종목 이동 안내' })).toBeNull();
  expect(screen.getByText('그림 1개 삭제됨')).toBeInTheDocument();
});

it('닫기 버튼으로 이동 안내를 즉시 닫는다', async () => {
  setup();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '이동' })); });
  fireEvent.click(screen.getByRole('button', { name: '이동 안내 닫기' }));
  expect(screen.queryByRole('status', { name: '종목 이동 안내' })).toBeNull();
});
