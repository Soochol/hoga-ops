import { create } from 'zustand';
import type { LiveTimeframe } from '../state/livePage';

/**
 * sidebarCursorMs 발행 출처 (ADR-0119 PR-D 크로스헤어 버스).
 *
 * 멀티창에서 어느 차트 창의 호버인지 식별해야 같은 링크 그룹의 데이터 창만
 * 스팟 모드로 전환할 수 있다. Provider 밖(/study·단일 뷰)은 windowId/group
 * null 로 발행 — 기존 소비자(sidebarCursorMs 직독)는 origin 을 무시하므로
 * 무변경.
 */
export interface SidebarCursorOrigin {
  windowId: string | null;
  group: number | null;
  /** 발행 차트의 code — 주식=6자리, 지수=`index:ID`(LiveChartRoot prop 그대로). */
  code: string | null;
  timeframe: LiveTimeframe;
}

interface State {
  cursorMs: number | null;
  lastCursorMs: number | null;
  sidebarCursorMs: number | null;
  sidebarCursorOrigin: SidebarCursorOrigin | null;
  setCursor: (t: number) => void;
  setSidebarCursor: (t: number, origin?: SidebarCursorOrigin | null) => void;
  clearCursor: () => void;
  clearSidebarCursor: () => void;
  restoreCursor: () => void;
  resetCursor: () => void;
}

function sameOrigin(a: SidebarCursorOrigin | null, b: SidebarCursorOrigin | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.windowId === b.windowId &&
    a.group === b.group &&
    a.code === b.code &&
    a.timeframe === b.timeframe
  );
}

/**
 * /live page hover cursor.
 * - cursorMs: immediate chart/legend hover timestamp.
 * - lastCursorMs: sticky last-valid hover timestamp for restore after pointer leave.
 * - sidebarCursorMs: rate-limited cursor consumed by LiveSidebar and spot REST hooks.
 * - sidebarCursorOrigin: 발행 차트 창의 (windowId·group·code·timeframe) — 데이터 창
 *   그룹 게이트용(ADR-0119 PR-D). sidebarCursorMs 와 원자적으로 갱신/해제된다.
 * See ADR-0044.
 */
export const useLiveCursorStore = create<State>((set, get) => ({
  cursorMs: null,
  lastCursorMs: null,
  sidebarCursorMs: null,
  sidebarCursorOrigin: null,
  setCursor: (t) => {
    const { cursorMs, lastCursorMs } = get();
    if (cursorMs === t && lastCursorMs === t) return; // identity-stable, no-op rerender
    set({ cursorMs: t, lastCursorMs: t });
  },
  setSidebarCursor: (t, origin = null) => {
    const { sidebarCursorMs, sidebarCursorOrigin } = get();
    if (sidebarCursorMs === t && sameOrigin(sidebarCursorOrigin, origin)) return;
    set({ sidebarCursorMs: t, sidebarCursorOrigin: origin });
  },
  clearCursor: () => {
    if (get().cursorMs === null) return;
    set({ cursorMs: null });
  },
  clearSidebarCursor: () => {
    const { sidebarCursorMs, sidebarCursorOrigin } = get();
    if (sidebarCursorMs === null && sidebarCursorOrigin === null) return;
    set({ sidebarCursorMs: null, sidebarCursorOrigin: null });
  },
  restoreCursor: () => {
    const { cursorMs, lastCursorMs } = get();
    if (cursorMs === lastCursorMs) return;
    set({ cursorMs: lastCursorMs });
  },
  resetCursor: () => {
    const s = get();
    if (s.cursorMs === null && s.lastCursorMs === null
      && s.sidebarCursorMs === null && s.sidebarCursorOrigin === null) return;
    set({ cursorMs: null, lastCursorMs: null, sidebarCursorMs: null, sidebarCursorOrigin: null });
  },
}));
