// frontend/src/live/useLiveCursorStore.test.ts
import { describe, expect, it, beforeEach } from 'vitest';
import { useLiveCursorStore } from './useLiveCursorStore';

describe('useLiveCursorStore', () => {
  beforeEach(() => {
    useLiveCursorStore.getState().resetCursor();
  });

  it('starts with cursorMs null', () => {
    expect(useLiveCursorStore.getState().cursorMs).toBeNull();
    expect(useLiveCursorStore.getState().lastCursorMs).toBeNull();
    expect(useLiveCursorStore.getState().sidebarCursorMs).toBeNull();
  });

  it('setCursor stores the value', () => {
    useLiveCursorStore.getState().setCursor(1748400000000);
    expect(useLiveCursorStore.getState().cursorMs).toBe(1748400000000);
    expect(useLiveCursorStore.getState().lastCursorMs).toBe(1748400000000);
  });

  it('clearCursor resets to null', () => {
    useLiveCursorStore.getState().setCursor(1748400000000);
    useLiveCursorStore.getState().clearCursor();
    expect(useLiveCursorStore.getState().cursorMs).toBeNull();
    expect(useLiveCursorStore.getState().lastCursorMs).toBe(1748400000000);
  });

  it('restoreCursor rehydrates cursorMs from lastCursorMs', () => {
    useLiveCursorStore.getState().setCursor(1748400000000);
    useLiveCursorStore.getState().clearCursor();
    useLiveCursorStore.getState().restoreCursor();
    expect(useLiveCursorStore.getState().cursorMs).toBe(1748400000000);
    expect(useLiveCursorStore.getState().lastCursorMs).toBe(1748400000000);
  });

  it('restoreCursor 는 cursorOrigin 을 null 로 걷는다 (pair-atomicity, 리뷰)', () => {
    // 이전 창 origin 이 남은 채 cursorMs 만 되살아나면 stale 창 오미러 → origin 리셋.
    useLiveCursorStore.getState().setCursor(1748400000000, {
      windowId: 'wA', group: 1, code: '005930', timeframe: '1m',
    });
    useLiveCursorStore.getState().clearCursor();
    useLiveCursorStore.getState().restoreCursor();
    expect(useLiveCursorStore.getState().cursorMs).toBe(1748400000000);
    expect(useLiveCursorStore.getState().cursorOrigin).toBeNull();
  });

  it('resetCursor clears cursorMs and lastCursorMs', () => {
    useLiveCursorStore.getState().setCursor(1748400000000);
    useLiveCursorStore.getState().setSidebarCursor(1748400000000);
    useLiveCursorStore.getState().resetCursor();
    expect(useLiveCursorStore.getState().cursorMs).toBeNull();
    expect(useLiveCursorStore.getState().lastCursorMs).toBeNull();
    expect(useLiveCursorStore.getState().sidebarCursorMs).toBeNull();
  });

  it('setCursor with same value is a no-op for subscribers', () => {
    // Implementation should not trigger needless rerenders.
    useLiveCursorStore.getState().setCursor(123);
    let calls = 0;
    const unsub = useLiveCursorStore.subscribe(() => { calls += 1; });
    useLiveCursorStore.getState().setCursor(123);
    unsub();
    expect(calls).toBe(0);
  });

  it('setSidebarCursor stores a sidebar-specific value without changing cursorMs', () => {
    useLiveCursorStore.getState().setCursor(1748400000123);
    useLiveCursorStore.getState().setSidebarCursor(1748400000000);

    expect(useLiveCursorStore.getState().cursorMs).toBe(1748400000123);
    expect(useLiveCursorStore.getState().sidebarCursorMs).toBe(1748400000000);
  });

  it('setSidebarCursor with same value is a no-op for subscribers', () => {
    useLiveCursorStore.getState().setSidebarCursor(123);
    let calls = 0;
    const unsub = useLiveCursorStore.subscribe((state) => {
      if (state.sidebarCursorMs === 123) calls += 1;
    });
    useLiveCursorStore.getState().setSidebarCursor(123);
    unsub();
    expect(calls).toBe(0);
  });

  it('clearSidebarCursor clears only sidebarCursorMs', () => {
    useLiveCursorStore.getState().setCursor(1748400000123);
    useLiveCursorStore.getState().setSidebarCursor(1748400000000);
    useLiveCursorStore.getState().clearSidebarCursor();

    expect(useLiveCursorStore.getState().cursorMs).toBe(1748400000123);
    expect(useLiveCursorStore.getState().sidebarCursorMs).toBeNull();
  });
});

describe('useLiveCursorStore — sidebarCursorOrigin (ADR-0119 PR-D 크로스헤어 버스)', () => {
  const origin = (group: number | null) => ({
    windowId: group === null ? null : `w${group}`,
    group,
    code: '005930',
    timeframe: '1m' as const,
  });

  beforeEach(() => {
    useLiveCursorStore.getState().resetCursor();
  });

  it('setSidebarCursor 는 origin 을 함께 저장한다 (생략 시 null)', () => {
    useLiveCursorStore.getState().setSidebarCursor(123, origin(1));
    expect(useLiveCursorStore.getState().sidebarCursorOrigin?.group).toBe(1);
    useLiveCursorStore.getState().setSidebarCursor(456);
    expect(useLiveCursorStore.getState().sidebarCursorOrigin).toBeNull();
  });

  it('같은 ms + 같은 origin 은 no-op — 다른 origin 이면 갱신한다', () => {
    useLiveCursorStore.getState().setSidebarCursor(123, origin(1));
    let calls = 0;
    const unsub = useLiveCursorStore.subscribe(() => { calls += 1; });
    useLiveCursorStore.getState().setSidebarCursor(123, origin(1)); // no-op
    expect(calls).toBe(0);
    useLiveCursorStore.getState().setSidebarCursor(123, origin(2)); // origin 교체
    unsub();
    expect(calls).toBe(1);
    expect(useLiveCursorStore.getState().sidebarCursorOrigin?.group).toBe(2);
  });

  it('clearSidebarCursor / resetCursor 는 origin 도 함께 걷는다', () => {
    useLiveCursorStore.getState().setSidebarCursor(123, origin(1));
    useLiveCursorStore.getState().clearSidebarCursor();
    expect(useLiveCursorStore.getState().sidebarCursorOrigin).toBeNull();
    useLiveCursorStore.getState().setSidebarCursor(123, origin(1));
    useLiveCursorStore.getState().resetCursor();
    expect(useLiveCursorStore.getState().sidebarCursorOrigin).toBeNull();
  });
});

describe('useLiveCursorStore — cursorOrigin (즉시 커서, 크로스헤어 미러 PR-D2)', () => {
  const origin = (group: number | null) => ({
    windowId: group === null ? null : `w${group}`,
    group,
    code: '005930',
    timeframe: '1m' as const,
  });

  beforeEach(() => {
    useLiveCursorStore.getState().resetCursor();
  });

  it('setCursor 는 cursorOrigin 을 함께 저장한다(생략 시 null)', () => {
    useLiveCursorStore.getState().setCursor(123, origin(1));
    expect(useLiveCursorStore.getState().cursorOrigin?.group).toBe(1);
    useLiveCursorStore.getState().setCursor(456);
    expect(useLiveCursorStore.getState().cursorOrigin).toBeNull();
  });

  it('sidebarCursorOrigin(스로틀)과 독립적으로 관리된다', () => {
    useLiveCursorStore.getState().setCursor(123, origin(1));
    useLiveCursorStore.getState().setSidebarCursor(120, origin(2));
    expect(useLiveCursorStore.getState().cursorOrigin?.group).toBe(1);
    expect(useLiveCursorStore.getState().sidebarCursorOrigin?.group).toBe(2);
  });

  it('같은 ms + 같은 origin 은 no-op, 다른 origin 이면 갱신', () => {
    useLiveCursorStore.getState().setCursor(123, origin(1));
    let calls = 0;
    const unsub = useLiveCursorStore.subscribe(() => { calls += 1; });
    useLiveCursorStore.getState().setCursor(123, origin(1)); // no-op
    expect(calls).toBe(0);
    useLiveCursorStore.getState().setCursor(123, origin(2)); // origin 교체
    unsub();
    expect(calls).toBe(1);
  });

  it('clearCursor / resetCursor 는 cursorOrigin 도 걷는다', () => {
    useLiveCursorStore.getState().setCursor(123, origin(1));
    useLiveCursorStore.getState().clearCursor();
    expect(useLiveCursorStore.getState().cursorOrigin).toBeNull();
    useLiveCursorStore.getState().setCursor(123, origin(1));
    useLiveCursorStore.getState().resetCursor();
    expect(useLiveCursorStore.getState().cursorOrigin).toBeNull();
  });
});
