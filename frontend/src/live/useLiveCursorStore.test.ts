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

describe('useLiveCursorStore — 즉시 커서 (crosshair mirror 제거 후)', () => {
  beforeEach(() => {
    useLiveCursorStore.getState().resetCursor();
  });

  it('같은 ms 재발행은 no-op — 구독자 재발화 없음', () => {
    useLiveCursorStore.getState().setCursor(123);
    let calls = 0;
    const unsub = useLiveCursorStore.subscribe(() => { calls += 1; });
    useLiveCursorStore.getState().setCursor(123); // no-op
    expect(calls).toBe(0);
    useLiveCursorStore.getState().setCursor(456);
    unsub();
    expect(calls).toBe(1);
  });

  it('sidebarCursorOrigin(스로틀 스팟용)은 즉시 커서와 독립적으로 유지된다', () => {
    useLiveCursorStore.getState().setCursor(123);
    useLiveCursorStore.getState().setSidebarCursor(120, {
      windowId: 'w2', group: 2, code: '005930', timeframe: '1m',
    });
    expect(useLiveCursorStore.getState().cursorMs).toBe(123);
    expect(useLiveCursorStore.getState().sidebarCursorOrigin?.group).toBe(2);
  });

  describe('syncCursor — 창 간 크로스헤어 동기화 채널', () => {
    const origin = { windowId: 'w1', group: null, code: '064350', timeframe: '3m' } as const;

    it('origin 과 함께 즉시 실린다 — 스로틀도 버킷 정렬도 없다', () => {
      useLiveCursorStore.getState().setSyncCursor(1748400000123, origin);

      expect(useLiveCursorStore.getState().syncCursorMs).toBe(1748400000123);
      expect(useLiveCursorStore.getState().syncCursorOrigin?.timeframe).toBe('3m');
    });

    it('발행자만 자기 것을 지운다 — 옆 창의 leave 가 남의 발행을 끄면 안 된다', () => {
      useLiveCursorStore.getState().setSyncCursor(1748400000000, origin);

      useLiveCursorStore.getState().clearSyncCursorFrom('other-window');
      expect(useLiveCursorStore.getState().syncCursorMs).toBe(1748400000000);

      useLiveCursorStore.getState().clearSyncCursorFrom('w1');
      expect(useLiveCursorStore.getState().syncCursorMs).toBeNull();
      expect(useLiveCursorStore.getState().syncCursorOrigin).toBeNull();
    });

    it('restoreCursor 가 되살리지 않는다 — sticky 채널과 분리한 이유', () => {
      // `cursorMs` 에 origin 을 얹었다면 여기서 크로스헤어가 되살아난다. 포인터가
      // 발행 창을 떠난 뒤 옆 창에 선이 다시 뜨는 것이 그 증상이다.
      useLiveCursorStore.getState().setCursor(1748400000000);
      useLiveCursorStore.getState().setSyncCursor(1748400000000, origin);
      useLiveCursorStore.getState().clearCursor();
      useLiveCursorStore.getState().clearSyncCursorFrom('w1');

      useLiveCursorStore.getState().restoreCursor();

      expect(useLiveCursorStore.getState().cursorMs).toBe(1748400000000);
      expect(useLiveCursorStore.getState().syncCursorMs).toBeNull();
    });

    it('resetCursor 가 함께 비운다 — 종목 변경·언마운트 경로', () => {
      useLiveCursorStore.getState().setSyncCursor(1748400000000, origin);
      useLiveCursorStore.getState().resetCursor();

      expect(useLiveCursorStore.getState().syncCursorMs).toBeNull();
      expect(useLiveCursorStore.getState().syncCursorOrigin).toBeNull();
    });
  });
});
