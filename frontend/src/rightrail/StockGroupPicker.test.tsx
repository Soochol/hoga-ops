import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import * as heatmapApi from '../api/heatmap';
import * as watchlistApi from '../api/watchlist';
import type { HeatmapResponse } from '../api/heatmap';
import type { WatchlistResponse } from '../api/watchlist';
import { StockGroupPicker } from './StockGroupPicker';

function setup(code = '005930') {
  const watchlist: WatchlistResponse = {
    folders: [{ id: 'w_a', name: '관찰', order: 0 }],
    entries: [{ code, name: '삼성전자', folder_id: 'w_a', order: 0, registered_at_kst_date: '20261101', last_success_date: null }],
    memos: [], next_run_at_ms: 0,
  };
  let heatmap: HeatmapResponse = {
    folders: [{ id: 'h_a', name: '반도체', order: 0 }, { id: 'h_b', name: '대형주', order: 1 }],
    entries: [{ code, name: '삼성전자', folder_id: 'h_a', order: 0 }], capture_markers: {}, next_run_at_ms: 0,
  };
  const readHeatmap = vi.spyOn(heatmapApi, 'getHeatmap').mockImplementation(async () => heatmap);
  vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(watchlist);
  const addWatch = vi.spyOn(watchlistApi, 'addMember');
  const removeWatch = vi.spyOn(watchlistApi, 'removeMember');
  const addHeat = vi.spyOn(heatmapApi, 'addToHeatmapFolder').mockImplementation(async (c, folderId) => {
    const entry = { code: c, name: '삼성전자', folder_id: folderId, order: 0 };
    heatmap = { ...heatmap, entries: [...heatmap.entries.filter(e => e.code !== c || e.folder_id !== folderId), entry] };
    return entry;
  });
  const removeHeat = vi.spyOn(heatmapApi, 'removeFromHeatmapFolder').mockImplementation(async (c, folderId) => {
    heatmap = { ...heatmap, entries: heatmap.entries.filter(e => e.code !== c || e.folder_id !== folderId) };
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(['watchlist'], watchlist);
  qc.setQueryData(['heatmap'], heatmap);
  render(<QueryClientProvider client={qc}>
    <StockGroupPicker code={code} name="삼성전자" x={0} y={0} onClose={vi.fn()} />
  </QueryClientProvider>);
  return { qc, readHeatmap, addHeat, removeHeat, addWatch, removeWatch };
}

beforeEach(() => vi.restoreAllMocks());

it('switches independent memberships, updates counts and preserves undo across tabs', async () => {
  const { addHeat, removeHeat, addWatch, removeWatch } = setup();
  const heatTab = screen.getByRole('tab', { name: '히트맵' });
  expect(screen.getByRole('checkbox', { name: '관찰' })).toBeChecked();
  expect(heatTab).toHaveTextContent('1');
  fireEvent.click(heatTab);
  fireEvent.click(screen.getByRole('checkbox', { name: '대형주' }));
  await waitFor(() => expect(heatTab).toHaveTextContent('2'));
  expect(addHeat).toHaveBeenCalledWith('005930', 'h_b');
  fireEvent.click(screen.getByRole('tab', { name: '관심종목' }));
  expect(screen.getByRole('checkbox', { name: '관찰' })).toBeChecked();
  fireEvent.click(heatTab);
  fireEvent.click(await screen.findByRole('button', { name: '실행 취소' }));
  await waitFor(() => expect(screen.getByRole('checkbox', { name: '대형주' })).not.toBeChecked());
  expect(screen.getByRole('checkbox', { name: '반도체' })).toBeChecked();
  expect(removeHeat).toHaveBeenCalledWith('005930', 'h_b');
  expect(addWatch).not.toHaveBeenCalled();
  expect(removeWatch).not.toHaveBeenCalled();
});

it('keeps a failed heatmap change unchecked and supports retry', async () => {
  const { addHeat } = setup();
  addHeat.mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(screen.getByRole('tab', { name: '히트맵' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '대형주' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('저장하지 못했습니다');
  expect(screen.getByRole('checkbox', { name: '대형주' })).not.toBeChecked();
  fireEvent.click(screen.getByRole('checkbox', { name: '대형주' }));
  await waitFor(() => expect(screen.getByRole('checkbox', { name: '대형주' })).toBeChecked());
  expect(screen.queryByRole('alert')).toBeNull();
});

it('creates and registers in the heatmap and can undo that membership', async () => {
  const { addHeat, removeHeat } = setup();
  vi.spyOn(heatmapApi, 'createHeatmapFolder').mockResolvedValue({ id: 'h_new', name: '새 섹터', order: 2 });
  fireEvent.click(screen.getByRole('tab', { name: '히트맵' }));
  fireEvent.change(screen.getByRole('textbox', { name: '새 히트맵 그룹' }), { target: { value: '새 섹터' } });
  fireEvent.click(screen.getByRole('button', { name: '등록' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '실행 취소' })).toBeEnabled());
  expect(addHeat).toHaveBeenCalledWith('005930', 'h_new');
  fireEvent.click(screen.getByRole('button', { name: '실행 취소' }));
  await waitFor(() => expect(removeHeat).toHaveBeenCalledWith('005930', 'h_new'));
});

it('supports tab keys and blocks heatmap registration for US stocks', () => {
  setup('us-stock:NASDAQ:AAPL');
  const watchTab = screen.getByRole('tab', { name: '관심종목' });
  expect(screen.getByRole('tab', { name: '히트맵' })).toBeDisabled();
  fireEvent.keyDown(watchTab, { key: 'ArrowRight' });
  expect(watchTab).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tabpanel')).toHaveAccessibleName('관심종목');
});

it('activates tabs with arrow keys and keeps the selected tab in the tab order', () => {
  setup();
  fireEvent.keyDown(screen.getByRole('tab', { name: '관심종목' }), { key: 'ArrowRight' });
  const heatTab = screen.getByRole('tab', { name: '히트맵' });
  expect(heatTab).toHaveFocus();
  expect(heatTab).toHaveAttribute('aria-selected', 'true');
  expect(within(screen.getByRole('tabpanel')).getByRole('checkbox', { name: '반도체' })).toBeChecked();
});
