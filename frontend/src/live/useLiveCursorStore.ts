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
  syncCursorMs: number | null;
  syncCursorOrigin: SidebarCursorOrigin | null;
  setCursor: (t: number) => void;
  setSidebarCursor: (t: number, origin?: SidebarCursorOrigin | null) => void;
  /** 창 간 크로스헤어 동기화 채널 — 즉시 발행 + origin. 아래 주석 참조. */
  setSyncCursor: (t: number, origin: SidebarCursorOrigin) => void;
  clearCursor: () => void;
  clearSidebarCursor: () => void;
  /** 발행자만 자기 것을 지운다 — 옆 창의 mouse-leave 가 내 표시를 끄면 안 된다. */
  clearSyncCursorFrom: (windowId: string | null) => void;
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
 * - syncCursorMs / syncCursorOrigin: **창 간 크로스헤어 동기화** 전용 채널
 *   (`/study` 분봉 창 호버 → 일봉 창 크로스헤어). 아래 세 문단이 왜 기존 두 채널을
 *   쓰지 못하는지다.
 * See ADR-0044.
 *
 * ── 왜 세 번째 채널인가 ───────────────────────────────────────────────────
 * `cursorMs` 는 즉시 발행이지만 **origin 이 없다** — 소비 창이 "이건 내 호버다" 를
 * 구별하지 못해 자기 크로스헤어와 이중으로 그린다. `sidebarCursorMs` 는 origin 은
 * 있지만 throttle + 버킷 정렬이라 **시각 동기화엔 늦다**(데이터 조회용 채널이다).
 *
 * `cursorMs` 에 origin 을 얹지 않은 이유는 따로 있다: 그 채널은
 * `lastCursorMs`/`restoreCursor` 의 **sticky 복원 의미론**을 가진다. 거기 태우면
 * 포인터가 발행 창을 떠난 뒤의 restore 가 옆 창 크로스헤어를 되살린다 — "떠나면
 * 지워진다" 라는 이 기능의 계약과 정면으로 어긋난다. 그래서 sticky 가 없는 별도
 * 필드 한 쌍으로 둔다.
 */
export const useLiveCursorStore = create<State>((set, get) => ({
  cursorMs: null,
  lastCursorMs: null,
  sidebarCursorMs: null,
  sidebarCursorOrigin: null,
  syncCursorMs: null,
  syncCursorOrigin: null,
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
  setSyncCursor: (t, origin) => {
    const { syncCursorMs, syncCursorOrigin } = get();
    if (syncCursorMs === t && sameOrigin(syncCursorOrigin, origin)) return;
    set({ syncCursorMs: t, syncCursorOrigin: origin });
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
  clearSyncCursorFrom: (windowId) => {
    const { syncCursorMs, syncCursorOrigin } = get();
    if (syncCursorMs === null && syncCursorOrigin === null) return;
    // 다른 창이 발행 중이면 건드리지 않는다. 창이 셋 이상일 때 한 창의 mouse-leave 가
    // 다른 창의 유효한 발행을 지우는 것을 막는다.
    if (syncCursorOrigin !== null && syncCursorOrigin.windowId !== windowId) return;
    set({ syncCursorMs: null, syncCursorOrigin: null });
  },
  restoreCursor: () => {
    const { cursorMs, lastCursorMs } = get();
    if (cursorMs === lastCursorMs) return;
    set({ cursorMs: lastCursorMs });
  },
  resetCursor: () => {
    const s = get();
    if (s.cursorMs === null && s.lastCursorMs === null
      && s.sidebarCursorMs === null && s.sidebarCursorOrigin === null
      && s.syncCursorMs === null && s.syncCursorOrigin === null) return;
    set({
      cursorMs: null, lastCursorMs: null, sidebarCursorMs: null, sidebarCursorOrigin: null,
      syncCursorMs: null, syncCursorOrigin: null,
    });
  },
}));
