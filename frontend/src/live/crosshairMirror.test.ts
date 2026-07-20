import { describe, it, expect } from 'vitest';
import { shouldMirrorCursor, mirrorCandleClose } from './crosshairMirror';
import type { SidebarCursorOrigin } from './useLiveCursorStore';

const origin = (windowId: string | null, group: number | null): SidebarCursorOrigin => ({
  windowId, group, code: '005930', timeframe: '1m',
});

describe('shouldMirrorCursor (ADR-0119 PR-D2)', () => {
  it('같은 그룹의 다른 창이 호버 중이면 true', () => {
    expect(shouldMirrorCursor({
      myWindowId: 'wA', myGroup: 1, cursorMs: 123, origin: origin('wB', 1),
    })).toBe(true);
  });

  it('내가 발행자면(같은 windowId) false — 자기 크로스헤어는 lwc 가 그린다', () => {
    expect(shouldMirrorCursor({
      myWindowId: 'wA', myGroup: 1, cursorMs: 123, origin: origin('wA', 1),
    })).toBe(false);
  });

  it('다른 그룹이면 false', () => {
    expect(shouldMirrorCursor({
      myWindowId: 'wA', myGroup: 1, cursorMs: 123, origin: origin('wB', 2),
    })).toBe(false);
  });

  it('커서가 없으면(cursorMs null) false → 미러 clear', () => {
    expect(shouldMirrorCursor({
      myWindowId: 'wA', myGroup: 1, cursorMs: null, origin: origin('wB', 1),
    })).toBe(false);
  });

  it('origin 이 없으면 false', () => {
    expect(shouldMirrorCursor({
      myWindowId: 'wA', myGroup: 1, cursorMs: 123, origin: null,
    })).toBe(false);
  });

  it('Provider 밖(myWindowId null=/study·단일 뷰)은 항상 false — 미러 불참', () => {
    expect(shouldMirrorCursor({
      myWindowId: null, myGroup: null, cursorMs: 123, origin: origin('wB', 1),
    })).toBe(false);
  });
});

describe('mirrorCandleClose', () => {
  const candles = [
    { ts_ms: 100, close: 10 },
    { ts_ms: 200, close: 20 },
    { ts_ms: 300, close: 30 },
  ];

  it('cursorMs 이하 가장 가까운 봉의 close', () => {
    expect(mirrorCandleClose(candles, 250)).toBe(20);
    expect(mirrorCandleClose(candles, 200)).toBe(20);
    expect(mirrorCandleClose(candles, 350)).toBe(30);
  });

  it('cursorMs 가 첫 봉보다 이르면 첫 봉 close', () => {
    expect(mirrorCandleClose(candles, 50)).toBe(10);
  });

  it('봉이 없으면 null(미러 스킵)', () => {
    expect(mirrorCandleClose([], 123)).toBeNull();
  });
});
