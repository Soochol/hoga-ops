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
  /** 즉시(무스로틀) 커서의 발행 출처 — 크로스헤어 미러가 cursorMs 와 짝으로 읽는다
   *  (ADR-0119 PR-D2). 스로틀 스팟용 sidebarCursorOrigin 과 값은 같은 차트지만,
   *  각자의 커서(cursorMs/sidebarCursorMs)와 원자적으로 set/clear 돼 결합이 낮다. */
  cursorOrigin: SidebarCursorOrigin | null;
  sidebarCursorMs: number | null;
  sidebarCursorOrigin: SidebarCursorOrigin | null;
  setCursor: (t: number, origin?: SidebarCursorOrigin | null) => void;
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
  cursorOrigin: null,
  sidebarCursorMs: null,
  sidebarCursorOrigin: null,
  setCursor: (t, origin = null) => {
    const { cursorMs, lastCursorMs, cursorOrigin } = get();
    // identity-stable, no-op rerender — origin 도 같을 때만 skip.
    if (cursorMs === t && lastCursorMs === t && sameOrigin(cursorOrigin, origin)) return;
    set({ cursorMs: t, lastCursorMs: t, cursorOrigin: origin });
  },
  setSidebarCursor: (t, origin = null) => {
    const { sidebarCursorMs, sidebarCursorOrigin } = get();
    if (sidebarCursorMs === t && sameOrigin(sidebarCursorOrigin, origin)) return;
    set({ sidebarCursorMs: t, sidebarCursorOrigin: origin });
  },
  clearCursor: () => {
    const { cursorMs, cursorOrigin } = get();
    if (cursorMs === null && cursorOrigin === null) return;
    set({ cursorMs: null, cursorOrigin: null });
  },
  clearSidebarCursor: () => {
    const { sidebarCursorMs, sidebarCursorOrigin } = get();
    if (sidebarCursorMs === null && sidebarCursorOrigin === null) return;
    set({ sidebarCursorMs: null, sidebarCursorOrigin: null });
  },
  restoreCursor: () => {
    const { cursorMs, lastCursorMs, cursorOrigin } = get();
    if (cursorMs === lastCursorMs && cursorOrigin === null) return;
    // cursorMs 를 되살릴 때 origin 은 걷는다(발행 창을 모르는 복원) — 다른 mutator 의
    // pair-atomicity 유지. origin null = 미러 게이트 실패 = stale 창 오미러 방지(리뷰).
    set({ cursorMs: lastCursorMs, cursorOrigin: null });
  },
  resetCursor: () => {
    const s = get();
    if (s.cursorMs === null && s.lastCursorMs === null && s.cursorOrigin === null
      && s.sidebarCursorMs === null && s.sidebarCursorOrigin === null) return;
    set({ cursorMs: null, lastCursorMs: null, cursorOrigin: null, sidebarCursorMs: null, sidebarCursorOrigin: null });
  },
}));
