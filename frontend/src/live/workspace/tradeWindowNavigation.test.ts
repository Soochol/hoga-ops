import { beforeEach, expect, it } from 'vitest';
import { useWorkspaceStore, windowSymbolOf, type WorkspaceWindow } from '../../state/workspace';
import { useLiveVenueStore } from '../../state/liveVenue';
import { useLiveCursorStore } from '../useLiveCursorStore';
import { openTradeWindow } from './tradeWindowNavigation';

const subject = { code: '005930', name: '삼성전자' };
const other = { code: '000660', name: 'SK하이닉스' };
const win = (id: string, kind: WorkspaceWindow['kind'], group = 3): WorkspaceWindow => (
  { id, kind, group, rect: { x: 0, y: 0, w: .3, h: .7 } }
);
beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  useWorkspaceStore.setState({ windows: [win('book', 'book'), win('order', 'order'), win('other', 'chart', 7)],
    zOrder: ['book', 'order', 'other'], groupSymbols: { 3: subject, 7: other }, maximizedId: null });
});

it.each(['book', 'order'])('opens from %s in its own group and reuses the tape without changing its filter or size', source => {
  const id = openTradeWindow(source)!;
  const ws = useWorkspaceStore.getState();
  const tape = ws.windows.find(w => w.id === id)!;
  expect(tape).toMatchObject({ kind: 'trade', group: 3 });
  expect(windowSymbolOf(ws, tape)).toEqual(subject);
  ws.setTradeMinAmountManwon(id, 3000);
  ws.focusWindow('other');
  expect(openTradeWindow(source)).toBe(id);
  expect(useWorkspaceStore.getState().windows).toHaveLength(4);
  expect(useWorkspaceStore.getState().windows.find(w => w.id === id)).toMatchObject({ rect: tape.rect, tradeMinAmountManwon: 3000 });
  expect(useWorkspaceStore.getState().zOrder.at(-1)).toBe(id);
  expect(useWorkspaceStore.getState().groupSymbols[7]).toEqual(other);
});

it('reuses the front matching tape and preserves different groups and pinned subjects', () => {
  useWorkspaceStore.setState(state => ({ windows: [...state.windows,
    win('first', 'trade'), win('wrong-group', 'trade', 7),
    { ...win('pinned-other', 'trade'), pinned: other }, win('front', 'trade')],
  zOrder: [...state.zOrder, 'first', 'front', 'wrong-group', 'pinned-other'] }));
  expect(openTradeWindow('book')).toBe('front');
  expect(useWorkspaceStore.getState().windows.find(w => w.id === 'pinned-other')?.pinned).toEqual(other);
});

it('opens a pinned source subject without changing its group and keeps the new tape pinned', () => {
  useWorkspaceStore.setState(state => ({ windows: state.windows.map(w => w.id === 'book' ? { ...w, pinned: other } : w) }));
  const id = openTradeWindow('book')!;
  const ws = useWorkspaceStore.getState();
  expect(ws.groupSymbols[3]).toEqual(subject);
  expect(ws.windows.find(w => w.id === id)?.pinned).toEqual(other);
  ws.setGroupSymbol(3, { code: '035720', name: '카카오' });
  expect(windowSymbolOf(useWorkspaceStore.getState(), ws.windows.find(w => w.id === id))).toEqual(other);
});

it('preserves the current venue and chart cursor when creating and focusing the tape', () => {
  useLiveVenueStore.setState({ venue: 'NXT' });
  useLiveCursorStore.setState({ sidebarCursorMs: 1000,
    sidebarCursorOrigin: { windowId: 'other', code: subject.code, group: 3, timeframe: '1m', venue: 'KRX' } });
  const cursor = useLiveCursorStore.getState();
  const id = openTradeWindow('order');
  expect(openTradeWindow('book')).toBe(id);
  expect(useLiveVenueStore.getState().venue).toBe('NXT');
  expect(useLiveCursorStore.getState()).toBe(cursor);
});

it('ignores a missing source or unsupported subject', () => {
  const before = useWorkspaceStore.getState();
  expect(openTradeWindow('missing')).toBeNull();
  expect(openTradeWindow('other')).toBeNull();
  expect(useWorkspaceStore.getState()).toBe(before);
  useWorkspaceStore.setState({ groupSymbols: { 3: { code: 'KOSPI', name: '코스피', kind: 'index' } } });
  expect(openTradeWindow('book')).toBeNull();
});
