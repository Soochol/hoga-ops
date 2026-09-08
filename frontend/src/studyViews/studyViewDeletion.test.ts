import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { StudyViewReference, StudyViewsFile } from '../api/studyViews';
import { useStudyViewDeletion } from './studyViewDeletion';
import { STUDY_VIEW_SAVES_QUERY } from './studyViewKeys';
import { useLivePageStore } from '../state/livePage';
import { savedRangeFocusFromView } from './savedRangeFocus';
const remove = vi.hoisted(() => vi.fn());
vi.mock('../api/studyViews', () => ({ deleteStudyView: remove }));
const row = (id: string): StudyViewReference => ({
  id, schema_version: 2, name: id, code: '005930', label: '삼성전자', timeframe: '5m', memo: '', tags: [],
  range: { from_date: '20260901', to_date: '20260901', from_ms: 1000, to_ms: 2000 },
  viewport: { right_edge_ms: 2000, bar_span: 10, at_live_edge: false }, created_at_ms: 1, updated_at_ms: 1,
});
let client: QueryClient;
beforeEach(() => {
  vi.useFakeTimers();
  remove.mockReset().mockResolvedValue(undefined);
  client = new QueryClient();
  client.setQueryData(STUDY_VIEW_SAVES_QUERY, { schema_version: 2, saves: [row('a'), row('b'), row('c')] });
  useLivePageStore.getState().clearSavedRange();
});
afterEach(() => {
  for (const batch of useStudyViewDeletion.getState().batches) useStudyViewDeletion.getState().undo(batch.id);
  useStudyViewDeletion.setState({ batches: [] });
  client.clear(); vi.clearAllTimers(); vi.useRealTimers();
});
const store = () => useStudyViewDeletion.getState();
it('retains failed rows and the open range, retries only failures, and reconciles the cache', async () => {
  useLivePageStore.getState().focusSavedRange(savedRangeFocusFromView(row('b')));
  remove.mockImplementation(async (id) => { if (id === 'b') throw new Error('offline'); });
  store().queue([row('a'), row('b')], client);
  await vi.advanceTimersByTimeAsync(5000);
  expect(store().batches[0]).toMatchObject({ phase: 'complete', deleted: 1, failed: [{ id: 'b' }] });
  expect(client.getQueryData<StudyViewsFile>(STUDY_VIEW_SAVES_QUERY)?.saves.map((r) => r.id)).toEqual(['b', 'c']);
  expect(useLivePageStore.getState().savedRangeFocus?.viewId).toBe('b');
  remove.mockResolvedValue(undefined);
  store().retry(store().batches[0].id);
  await vi.advanceTimersByTimeAsync(4999);
  expect(remove).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(remove.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'b']);
  expect(useLivePageStore.getState().savedRangeFocus).toBeNull();
  expect(client.getQueryData<StudyViewsFile>(STUDY_VIEW_SAVES_QUERY)?.saves.map((r) => r.id)).toEqual(['c']);
});
it('deduplicates pending rows and cannot undo an in-flight deletion', async () => {
  let resolve!: () => void;
  remove.mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
  store().queue([row('a'), row('a')], client);
  store().queue([row('a')], client);
  expect(store().batches).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(5000);
  store().undo(store().batches[0].id);
  expect(store().batches[0].phase).toBe('deleting');
  expect(remove).toHaveBeenCalledExactlyOnceWith('a');
  resolve(); await vi.advanceTimersByTimeAsync(0);
  expect(store().batches[0].phase).toBe('complete');
});
it('treats a concurrently removed view as success and bounds batch concurrency', async () => {
  remove.mockImplementation(() => new Promise<void>((_resolve, reject) => setTimeout(() => reject({ status: 404 }), 100)));
  store().queue(Array.from({ length: 9 }, (_, i) => row(String(i))), client);
  await vi.advanceTimersByTimeAsync(5000);
  expect(remove).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(100);
  expect(remove).toHaveBeenCalledTimes(8);
  await vi.advanceTimersByTimeAsync(200);
  expect(store().batches[0]).toMatchObject({ deleted: 9, failed: [], phase: 'complete' });
});
