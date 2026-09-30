import { beforeEach, expect, it } from 'vitest';
import { useLiveCursorStore } from '../useLiveCursorStore';
import { returnGroupToLatest } from './returnGroupToLatest';

beforeEach(() => useLiveCursorStore.getState().resetCursor());

it('returns the linked group to latest without clearing its range or pending timeframe jump', () => {
  const store = useLiveCursorStore.getState();
  const origin = { windowId: 'chart-1', group: 1, code: '005930', timeframe: '1m' as const };
  store.setSidebarCursor(1000, origin);
  store.setSyncCursor(1000, origin);
  store.setSyncRange(500, 1500, origin);
  store.requestTimeframeJump(500, 1500, origin);
  const range = useLiveCursorStore.getState().syncRange;
  const jump = useLiveCursorStore.getState().jumpRequest;
  returnGroupToLatest(1);
  expect(useLiveCursorStore.getState().sidebarCursorMs).toBeNull();
  expect(useLiveCursorStore.getState().syncCursorMs).toBeNull();
  expect(useLiveCursorStore.getState().syncRange).toBe(range);
  expect(useLiveCursorStore.getState().jumpRequest).toBe(jump);
});

it('does not clear a cursor published by another group', () => {
  const origin = { windowId: 'chart-2', group: 2, code: '000660', timeframe: '1m' as const };
  useLiveCursorStore.getState().setSidebarCursor(1000, origin);
  returnGroupToLatest(1);
  expect(useLiveCursorStore.getState().sidebarCursorMs).toBe(1000);
});
