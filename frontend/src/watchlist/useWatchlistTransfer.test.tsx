import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { transactWatchlistItems, type WatchlistFolderItemsChange } from '../api/watchlist';
import { useWatchlistTransfer } from './useWatchlistTransfer';

vi.mock('../api/watchlist', () => ({ transactWatchlistItems: vi.fn() }));
const changes: WatchlistFolderItemsChange[] = [{
  folder_id: 'folder',
  before: [{ kind: 'code', code: '005930' }, { kind: 'code', code: '000660' }],
  after: [{ kind: 'code', code: '000660' }, { kind: 'code', code: '005930' }],
}];
const label = '대원전선 → abcd · 가온전선 위로 이동';
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return renderHook(useWatchlistTransfer, {
    wrapper: ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(transactWatchlistItems).mockReset().mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('이동 완료 안내와 되돌리기는 5초 후 사라진다', async () => {
  const { result } = setup();
  await act(async () => { await result.current.run(changes, label); });
  act(() => { vi.advanceTimersByTime(4999); });
  expect(result.current.message).toBe(label);
  expect(result.current.canUndo).toBe(true);
  act(() => { vi.advanceTimersByTime(1); });
  expect(result.current.message).toBe('');
  expect(result.current.canUndo).toBe(false);
});

it('새 이동은 이전 타이머를 취소하고 완료 시부터 5초를 센다', async () => {
  const { result } = setup();
  await act(async () => { await result.current.run(changes, label); });
  act(() => { vi.advanceTimersByTime(4000); });
  let finish!: () => void;
  vi.mocked(transactWatchlistItems).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  let pending!: Promise<boolean>;
  await act(async () => { pending = result.current.run(changes, label); });
  act(() => { vi.advanceTimersByTime(6000); });
  expect(result.current.message).toBe('이동 중…');
  await act(async () => { finish(); await pending; });
  act(() => { vi.advanceTimersByTime(4999); });
  expect(result.current.message).toBe(label);
  act(() => { vi.advanceTimersByTime(1); });
  expect(result.current.message).toBe('');
});

it('되돌리기 완료 안내도 5초 후 사라진다', async () => {
  const { result } = setup();
  await act(async () => { await result.current.run(changes, label); });
  act(() => { vi.advanceTimersByTime(4000); });
  await act(async () => { await result.current.undo(); });
  expect(transactWatchlistItems).toHaveBeenLastCalledWith({ changes: [{
    folder_id: 'folder', before: changes[0].after, after: changes[0].before,
  }] });
  act(() => { vi.advanceTimersByTime(1000); });
  expect(result.current.message).toBe('이동을 되돌렸습니다');
  act(() => { vi.advanceTimersByTime(4000); });
  expect(result.current.message).toBe('');
});

it('실패 안내는 확인할 수 있도록 유지한다', async () => {
  vi.mocked(transactWatchlistItems).mockRejectedValueOnce(new Error('저장 실패'));
  const { result } = setup();
  await act(async () => { await result.current.run(changes, label); });
  act(() => { vi.advanceTimersByTime(10000); });
  expect(result.current.message).toContain('저장 실패');
  act(() => { result.current.dismiss(); });
  expect(result.current.message).toBe('');
});
