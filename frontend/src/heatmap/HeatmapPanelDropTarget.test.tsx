import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { HeatmapPanelDropTarget } from './HeatmapPanelDropTarget';
import { resolveDropOnHeatmap } from '../state/heatmapDrop';
import { useEntryDragStore } from '../state/entryDrag';
import { addToHeatmapFolder, type HeatmapResponse } from '../api/heatmap';
import { HEATMAP_KEY } from './heatmapKeys';

vi.mock('../api/heatmap', () => ({ addToHeatmapFolder: vi.fn() }));
const data: HeatmapResponse = {
  folders: [{ id: 'target', name: '반도체', order: 0 }], entries: [], capture_markers: {}, next_run_at_ms: 0,
};
const point = { x: 100, y: 100 }, entry = { code: '005930', name: '삼성전자' };
function setup(initial = data) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(HEATMAP_KEY, initial);
  const tree = (value: HeatmapResponse) => <QueryClientProvider client={qc}>
    <HeatmapPanelDropTarget data={value}><div data-heatmap-drop-folder="target">그룹</div></HeatmapPanelDropTarget>
  </QueryClientProvider>;
  const view = render(tree(initial));
  const elementFromPoint = vi.fn((): Element | null => screen.getByText('그룹'));
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: elementFromPoint });
  return { ...view, qc, elementFromPoint, update: (value: HeatmapResponse) => view.rerender(tree(value)) };
}
afterEach(() => { vi.clearAllMocks(); useEntryDragStore.getState().endDrag(); });

it('shows destination, consumes one addition, and reports success', async () => {
  vi.mocked(addToHeatmapFolder).mockResolvedValue({ ...entry, folder_id: 'target', order: 0 });
  setup();
  act(() => { useEntryDragStore.getState().startDrag(entry.code); useEntryDragStore.getState().setDragPoint(point); });
  expect(screen.getByRole('status')).toHaveTextContent('반도체 그룹에 추가');
  act(() => { expect(resolveDropOnHeatmap(point, entry)).toBe(true); useEntryDragStore.getState().endDrag(); });
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('삼성전자 · 반도체 그룹에 추가했습니다'));
  expect(addToHeatmapFolder).toHaveBeenCalledExactlyOnceWith('005930', 'target');
});

it('uses latest membership and leaves duplicate entries untouched', () => {
  const view = setup();
  view.update({ ...data, entries: [{ ...entry, folder_id: 'target', order: 0 }] });
  act(() => { expect(resolveDropOnHeatmap(point, entry)).toBe(true); });
  expect(screen.getByRole('status')).toHaveTextContent('이미 반도체 그룹에 등록된 종목입니다');
  expect(addToHeatmapFolder).not.toHaveBeenCalled();
});

it('merges the confirmed entry into the latest cache without losing other groups or capture markers', async () => {
  let resolve!: (value: Awaited<ReturnType<typeof addToHeatmapFolder>>) => void;
  vi.mocked(addToHeatmapFolder).mockReturnValue(new Promise((done) => { resolve = done; }));
  const view = setup();
  await act(async () => { resolveDropOnHeatmap(point, entry); });
  const other = { code: '000660', name: 'SK하이닉스', folder_id: 'other', order: 0 };
  const updated = { ...data, entries: [other], capture_markers: { '000660': '20260908' } };
  view.qc.setQueryData(HEATMAP_KEY, updated);
  const added = { ...entry, folder_id: 'target', order: 3 };
  await act(async () => resolve(added));
  expect(view.qc.getQueryData(HEATMAP_KEY)).toEqual({ ...updated, entries: [other, added] });
});

it('rechecks the topmost element on scroll and drop; unmount unregisters', () => {
  const view = setup();
  act(() => { useEntryDragStore.getState().startDrag(entry.code); useEntryDragStore.getState().setDragPoint(point); });
  view.elementFromPoint.mockReturnValue(document.body);
  act(() => window.dispatchEvent(new Event('scroll')));
  expect(screen.queryByRole('status')).toBeNull();
  expect(resolveDropOnHeatmap(point, entry)).toBe(false);
  view.unmount();
  expect(resolveDropOnHeatmap(point, entry)).toBe(false);
  expect(addToHeatmapFolder).not.toHaveBeenCalled();
});

it('blocks extra saves while pending and reports failure even after a data refresh', async () => {
  let reject!: (reason: Error) => void;
  vi.mocked(addToHeatmapFolder).mockReturnValue(new Promise((_, fail) => { reject = fail; }));
  const view = setup();
  act(() => { resolveDropOnHeatmap(point, entry); resolveDropOnHeatmap(point, entry); });
  view.update({ ...data });
  await act(async () => reject(new Error('저장 실패')));
  expect(screen.getByRole('status')).toHaveTextContent('종목을 추가하지 못했습니다 · 저장 실패');
  expect(addToHeatmapFolder).toHaveBeenCalledTimes(1);
});
