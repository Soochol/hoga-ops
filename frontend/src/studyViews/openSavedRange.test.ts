import { beforeEach, expect, it } from 'vitest';
import type { StudyViewListRow } from '../api/studyViews';
import { useWorkspaceStore, type WorkspaceWindow } from '../state/workspace';
import { useLivePageStore } from '../state/livePage';
import { registerSecondTimeframeViewport } from '../live/workspace/secondTimeframeViewport';
import { openSavedRange } from './openSavedRange';

const start = Date.parse('2026-10-23T09:00:00+09:00');
const win: WorkspaceWindow = { id: 'seconds', kind: 'chart', group: 1,
  chart: { timeframe: '5s' }, rect: { x: 0, y: 0, w: 1, h: 1 } };
const row: StudyViewListRow = { schema_version: 2, id: 'new-period', group_id: 'group',
  code: '005930', label: '삼성전자', timeframe: '10s', name: '다른 구간', memo: '', tags: [],
  range: { from_date: '20261023', to_date: '20261023', from_ms: start + 3600000, to_ms: start + 3660000 },
  viewport: { right_edge_ms: start + 3660000, bar_span: 6, at_live_edge: false }, created_at_ms: 1, updated_at_ms: 1 };
beforeEach(() => {
  useWorkspaceStore.setState({ windows: [win], zOrder: [win.id], chartRuntime: {},
    groupSymbols: { 1: { code: row.code, name: row.label } }, maximizedId: null });
  useLivePageStore.getState().clearSavedRange();
});
function registerOldView() {
  return registerSecondTimeframeViewport(win.id, () => ({ code: row.code, timeframe: '5s', venue: 'KRX', followLatest: false,
    viewport: { leftEdgeMs: start, rightEdgeMs: start + 60000, barSpan: 12, atLiveEdge: false } }));
}

it('a new saved view replaces the old viewport even when the same Code changes seconds resolution', () => {
  const cleanup = registerOldView();
  try {
    openSavedRange(row);
    expect(useWorkspaceStore.getState().windows[0].chart?.timeframe).toBe('10s');
    expect(useLivePageStore.getState().savedRangeFocus).toMatchObject({ viewId: row.id, fromMs: row.range.from_ms, toMs: row.range.to_ms });
    expect(useWorkspaceStore.getState().chartRuntime[win.id]?.secondViewport).toBeUndefined();
  } finally { cleanup(); }
});

it.each([null, { fromMs: start + 3600000, toMs: start + 3660000 }])('an explicit range command discards a pending viewport handoff: %j', range => {
  const cleanup = registerOldView();
  try {
    const ws = useWorkspaceStore.getState();
    ws.setChartTimeframe(win.id, '10s');
    expect(useWorkspaceStore.getState().chartRuntime[win.id].secondViewport).toBeDefined();
    ws.setSecondChartRange(win.id, range);
    expect(useWorkspaceStore.getState().chartRuntime[win.id].secondViewport).toBeUndefined();
  } finally { cleanup(); }
});
