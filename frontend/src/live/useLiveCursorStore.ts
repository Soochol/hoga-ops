import { create } from 'zustand';
import type { LiveTimeframe } from '../state/livePage';
import type { RangeSyncPublication } from '../chart/rangeSync';

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
  /** 창 간 **기간 동기화** 채널 — 분봉 창의 보이는 실시각 구간. `chart/rangeSync.ts`
   *  헤더가 왜 커서와 다른 채널인지를 갖는다(요약: 지속 상태 · 제스처 중에만 발행 ·
   *  stale 판정용 `seq`). 커서 채널과 달리 **포인터가 떠나도 지우지 않는다** —
   *  마지막으로 본 기간이 곧 현재 상태라 지울 대상이 아니다. */
  syncRange: RangeSyncPublication | null;
  setCursor: (t: number) => void;
  setSidebarCursor: (t: number, origin?: SidebarCursorOrigin | null) => void;
  /** 창 간 크로스헤어 동기화 채널 — 즉시 발행 + origin. 아래 주석 참조. */
  setSyncCursor: (t: number, origin: SidebarCursorOrigin) => void;
  /** 기간 동기화 발행. `seq` 는 스토어가 매긴다 — 발행자가 세면 창마다 자기 카운터를
   *  갖게 되어 "누구의 seq 인가" 가 생기고, 소비자의 stale 판정이 깨진다. */
  setSyncRange: (fromMs: number, toMs: number, origin: SidebarCursorOrigin) => void;
  clearCursor: () => void;
  /** 발행자만 자기 것을 지운다 — 근거는 `clearSyncCursorFrom` 과 동일(아래). */
  clearSidebarCursorFrom: (windowId: string | null) => void;
  /** 발행자만 자기 것을 지운다 — 옆 창의 mouse-leave 가 내 표시를 끄면 안 된다. */
  clearSyncCursorFrom: (windowId: string | null) => void;
  /** 발행 창이 닫힐 때만 비운다(언마운트 정리). 소유자 가드는 커서와 같다. */
  clearSyncRangeFrom: (windowId: string | null) => void;
  restoreCursor: () => void;
  /** 발행자만 자기 것을 지운다. 차트 언마운트·재생성 정리 경로 전용. */
  resetCursorFrom: (windowId: string | null) => void;
  /** ⚠ 소유자를 보지 않고 **전 채널을 지운다**. 테스트 초기화 전용 —
   *  프로덕션에서는 `resetCursorFrom` 을 쓸 것(이 함수를 창 정리 경로에 두면
   *  옆 창의 teardown 이 호버 중인 창의 스팟을 죽인다. 아래 소유자 절 참조). */
  resetCursor: () => void;
}

/**
 * 이 창이 현재 발행분의 주인인가.
 *
 * origin 이 **없으면** true — 누구 것인지 모르는 상태(스로틀 대기 중이라 아직
 * origin 이 안 붙었거나, Provider 밖 발행)까지 붙들면 정리 경로가 영영 막힌다.
 * 그래서 "모르면 지운다" 를 기본으로 두고 **주인이 분명히 다를 때만** 막는다 —
 * `clearSyncCursorFrom` 이 이미 쓰던 규칙 그대로다.
 */
function ownedBy(origin: SidebarCursorOrigin | null, windowId: string | null): boolean {
  return origin === null || origin.windowId === windowId;
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
 *
 * ── 지우는 쪽은 전부 소유자 가드를 통과한다 ────────────────────────────────
 * 슬롯은 전역 한 벌인데 발행자는 창마다다. 그래서 **지우는 함수는 반드시
 * `…From(windowId)` 형태**이고, 주인이 분명히 다르면 no-op 이다(`ownedBy`).
 *
 * 가드가 syncCursor 에만 있던 동안 `/live` 는 이렇게 깨졌다(2026-08-12 실측,
 * 003490 장중): 차트 창 2개에서 한쪽 캔들에 호버하면 10호가 창이 **틱마다 한
 * 프레임씩 최신 호가로 튀었다** — 29초에 19회. 옆 창의 crosshair effect 가
 * teardown 하며 `resetCursor()` 로 전역을 비웠고, 곧바로 호버 창의 다음 틱
 * 이벤트가 되살렸다. 차트 창을 하나 닫자 40초에 1회로 떨어졌다(대조).
 *
 * 지우는 쪽과 되살리는 쪽이 **둘 다 SSE 틱에 묶여** 있는 것이 이 증상의 정체다:
 * 마우스가 완전히 정지해 있어도 lwc 는 데이터 갱신마다 `crosshairMove` 를
 * 재발화한다(실측 초당 ~8회, 전부 `sourceEvent` 없음).
 */
export const useLiveCursorStore = create<State>((set, get) => ({
  cursorMs: null,
  lastCursorMs: null,
  sidebarCursorMs: null,
  sidebarCursorOrigin: null,
  syncCursorMs: null,
  syncCursorOrigin: null,
  syncRange: null,
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
  setSyncRange: (fromMs, toMs, origin) => {
    const prev = get().syncRange;
    // 같은 구간·같은 발행자면 no-op. 제스처 중에는 프레임마다 들어오는데, 값이 안
    // 바뀐 발행까지 store 를 쓰면 소비 창이 매 프레임 재렌더된다.
    if (prev && prev.fromMs === fromMs && prev.toMs === toMs && sameOrigin(prev.origin, origin)) {
      return;
    }
    set({ syncRange: { fromMs, toMs, seq: (prev?.seq ?? 0) + 1, origin } });
  },
  clearSyncRangeFrom: (windowId) => {
    const cur = get().syncRange;
    if (cur === null || !ownedBy(cur.origin, windowId)) return;
    set({ syncRange: null });
  },
  clearCursor: () => {
    if (get().cursorMs === null) return;
    set({ cursorMs: null });
  },
  clearSidebarCursorFrom: (windowId) => {
    const { sidebarCursorMs, sidebarCursorOrigin } = get();
    if (sidebarCursorMs === null && sidebarCursorOrigin === null) return;
    if (!ownedBy(sidebarCursorOrigin, windowId)) return;
    set({ sidebarCursorMs: null, sidebarCursorOrigin: null });
  },
  clearSyncCursorFrom: (windowId) => {
    const { syncCursorMs, syncCursorOrigin } = get();
    if (syncCursorMs === null && syncCursorOrigin === null) return;
    // 다른 창이 발행 중이면 건드리지 않는다. 창이 셋 이상일 때 한 창의 mouse-leave 가
    // 다른 창의 유효한 발행을 지우는 것을 막는다.
    if (!ownedBy(syncCursorOrigin, windowId)) return;
    set({ syncCursorMs: null, syncCursorOrigin: null });
  },
  restoreCursor: () => {
    const { cursorMs, lastCursorMs } = get();
    if (cursorMs === lastCursorMs) return;
    set({ cursorMs: lastCursorMs });
  },
  resetCursorFrom: (windowId) => {
    const s = get();
    // 주인 판정은 origin 이 붙는 두 채널로 한다. `cursorMs` 에는 origin 이 없지만
    // 같은 창이 `publishCursorMs` 에서 셋을 함께 발행하므로 주인이 같다 — 남의 창
    // teardown 이 내 `cursorMs` 를 지우는 것도 스팟이 지워지는 것과 같은 결함이다.
    const owner = s.sidebarCursorOrigin ?? s.syncCursorOrigin;
    if (!ownedBy(owner, windowId)) return;
    get().resetCursor();
  },
  resetCursor: () => {
    const s = get();
    // ⚠ 조기 반환 가드는 **아래 set 이 비우는 필드를 전부** 봐야 한다. 한 필드라도
    // 빠지면 그 필드만 남은 상태에서 reset 이 no-op 이 되어 다음 테스트로 샌다
    // (`syncRange` 를 추가하며 실제로 그렇게 새서 스펙 하나가 빨개졌다).
    if (s.cursorMs === null && s.lastCursorMs === null
      && s.sidebarCursorMs === null && s.sidebarCursorOrigin === null
      && s.syncCursorMs === null && s.syncCursorOrigin === null
      && s.syncRange === null) return;
    set({
      cursorMs: null, lastCursorMs: null, sidebarCursorMs: null, sidebarCursorOrigin: null,
      syncCursorMs: null, syncCursorOrigin: null, syncRange: null,
    });
  },
}));

/**
 * Dev 전용 QA 핸들 — 창 간 동기화 **버스 자체**를 브라우저에서 들여다보기 위한 것.
 *
 * 끝점(차트)만 보이고 그 사이 채널이 안 보이면, "발행자는 움직였는데 소비자가 안
 * 움직인다" 에서 원인을 **가정으로만** 좁히게 된다(발행이 없는가 · 게이트에 걸렸는가 ·
 * 적용이 실패했는가). 2026-08-21 `/browse` 검증에서 실제로 그 지점에 막혔다.
 *
 * `LiveChartRoot` 의 `__liveCharts` 와 같은 규약이다(dev 빌드에서만 존재).
 */
if (import.meta.env.DEV) {
  (window as unknown as { __liveCursorStore?: unknown }).__liveCursorStore = useLiveCursorStore;
}
