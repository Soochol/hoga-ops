import { REFERENCE_CANVAS as REF_CANVAS } from '../workspace/referenceCanvas';
import { normalizeZOrder } from '../workspace/zOrder';
import { create } from 'zustand';
import { persistJson, readJsonObject } from './persist';
import { WORKSPACE_STORAGE_KEY } from './workspaceKeys';
import {
  LIVE_TIMEFRAMES,
  MINUTE_TIMEFRAMES,
  isMinuteTimeframe,
  type LiveTimeframe,
  type MinuteTimeframe,
} from './livePage';
import { MIN_W, MIN_H, type Canvas, type Rect } from '../workspace/snapEngine';
import { isFracRect, toFrac } from '../workspace/rectSpace';
import { readLegacyWorkspaceSeed } from './workspaceMigration';
import { liveDefaultWindows } from './liveDefaultLayout';
import { isLiveIndexId } from '../live/liveInstrument';
import { BOOK_WINDOW_DEFAULT_W } from '../live/workspace/bookPanelMetrics';

/**
 * `/live` 멀티창 워크스페이스 상태 (ADR-0119, 스펙 #715).
 *
 * 창(차트·데이터)의 목록·배치·z순서와 링크 그룹→종목 매핑을 소유하고
 * `live.workspace.v1` 로 영속한다. 활성 그룹은 포커스 창(zOrder 마지막)에서
 * 파생하므로 저장하지 않는다(#711). PR-A 는 스캐폴딩 — 실제 차트/데이터 창
 * 배선과 구 키 마이그레이션은 PR-B/C 에서 붙는다.
 */

export { WORKSPACE_STORAGE_KEY };
/** 2 = rect 가 캔버스 대비 비율(ADR-0122). 없거나 낮으면 레거시 px 로 읽고 지연 비율화. */
export const WORKSPACE_SCHEMA_VERSION = 2;

/** 워크스페이스는 **모든 탭이 자기 sessionStorage 를 authoritative 저장소로** 쓴다.
 *
 *  이유: `persistFromState` 는 바뀐 필드가 아니라 **그 탭의 인메모리 스냅샷 전체**를
 *  쓴다(호출부 20여 곳이 전부 `{...state, 바뀐것}` 패턴). 두 탭이 같은 localStorage
 *  키를 공유하면, 오래된 탭에서 창 하나를 드래그하기만 해도 다른 탭의 종목·봉·
 *  레이아웃이 통째로 되돌아간다. 두 탭 화면은 각자 자기 메모리를 계속 보여주므로
 *  **조용히** 깨지고, 손실은 다음 새로고침에야 드러난다. sessionStorage 는 탭마다
 *  독립이라 이 경합을 구조적으로 없앤다.
 *
 *  대가는 "여기 담긴 것은 탭마다 갈린다" 이므로, **탭 전역이어야 하는 값을 이
 *  스냅샷에 넣으면 안 된다**. 보조지표 설정이 그 사례였다(#712 가 창에 넣었다가
 *  전역 `live.indicators.v2` 로 되돌렸다) — 사용자가 "앱 설정"으로 이해하는 값은
 *  `crossTabSync` 가 덮는 localStorage 쪽에 둔다.
 *
 *  공유 키(localStorage)는 이제 **새 탭의 시드 전용**이다 — 이미 열린 탭은 하이드레이션
 *  이후 두 번 다시 읽지 않으므로 누가 마지막에 썼든 무해하다. 메인 탭(쿼리 없는
 *  `/live`)만 write-through 로 시드를 갱신해 "새 탭 = 마지막으로 쓰던 레이아웃"을
 *  유지한다. 딥링크 탭(`?code=`·`?index=`)은 종전대로 공유 키를 건드리지 않는다.
 *
 *  대가: 탭을 닫으면 그 탭에서만 하던 배치는 사라진다(메인 탭은 시드에 남는다).
 *  아끼는 배치는 레이아웃 프리셋으로 저장한다 — 프리셋이 탭 간 유일한 다리다.
 *
 *  탭 수명 동안 고정한다(모듈 로드 1회 결정). `readStorage()` 가 모듈 초기화 시점에
 *  실행되므로 그보다 늦게 정해지면 하이드레이션이 틀린 저장소를 읽는다. SPA 내에서
 *  `/study` 를 거쳐 `/live` 로 돌아와도 판정이 흔들리지 않는 것도 같은 이유. */
function detectDeepLinkTab(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.has('code') || params.has('index');
  } catch {
    return false;
  }
}

let deepLinkCache: boolean | null = null;

function isDeepLinkTab(): boolean {
  deepLinkCache ??= detectDeepLinkTab();
  return deepLinkCache;
}

/** 창 종류. 'chart' 만 캔들+지표 스택, 나머지는 데이터 창(#708).
 *  'sector-ranking' 은 지수 그룹 전용 데이터 창(ADR-0119 PR-D). */
export const WINDOW_KINDS = ['chart', 'book', 'broker', 'trade', 'vdist', 'program', 'investor', 'sector-ranking'] as const;
export type WindowKind = (typeof WINDOW_KINDS)[number];

export const MIN_GROUP = 1;
export const MAX_GROUP = 10;
/** 링크 그룹 = 종목 SSOT (#711). 1..10. */
export type GroupId = number;

/**
 * 창 위치·크기 — **캔버스 대비 비율(0~1)**, px 아님 (ADR-0122).
 *
 * 캔버스가 줄면(줌인·창 축소) 창도 같은 비율로 줄어 배치가 보존되고 창이 밖으로
 * 나가지 않는다. px 계산이 필요한 쪽(snapEngine·드래그)은 `rectSpace` 의
 * toPx/toFrac 으로 캔버스에서 변환한다 — 스토어는 px 를 모른다.
 */
export interface WorkspaceRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 차트 창 전용 설정 — 창이 소유하는 것은 **봉뿐**이다(#708).
 *
 * 지표 설정도 한때 여기 있었지만(#712) 앱 전역 저장소(`live.indicators.v2`)로
 * 되돌렸다 — 워크스페이스는 탭별 sessionStorage 라, 창이 지표를 **소유하면**
 * 지표가 탭마다 갈라진다.
 *
 * 지표 세트는 이제 **페이지별**이다(ADR-0146 — `/live` ↔ `/study`). 그 축도 전역
 * localStorage 에 살지 이 스냅샷에 오지 않는다. 이 타입에 지표를 다시 넣으려는
 * 변경은 #712 를 그대로 재현하는 것이다.
 */
export interface ChartWindowConfig {
  timeframe: LiveTimeframe;
  /** 마지막 분봉 기억(창별) — 봉 컨트롤의 분봉 슬롯 복귀·Shift+m 용. 없으면 '1m'. */
  lastMinuteTimeframe?: MinuteTimeframe;
}

/** 창별 비영속 런타임 뷰 상태 (#713 뷰포트 비저장과 정합 — 세션 한정).
 *  좌측 팬 딥 백필의 창별 from-date 와 분봉 창 기억(livePage 의
 *  historicalFromDate/lastMinuteHistoricalFromDate 시맨틱을 창으로 절단). */
export interface ChartWindowRuntime {
  historicalFromDate: string | null;
  lastMinuteHistoricalFromDate: string | null;
}

export interface WorkspaceWindow {
  id: string;
  kind: WindowKind;
  group: GroupId;
  rect: WorkspaceRect;
  /** kind==='chart' 에서만 존재. */
  chart?: ChartWindowConfig;
}

export interface GroupSymbol {
  /** 주식=6자리 코드, 지수=LiveIndexId('KOSPI' 등). */
  code: string;
  name: string;
  /** 생략 = 'stock'(하위호환 — 기존 저장값·검색 경로 대부분). */
  kind?: 'stock' | 'index';
}

type Persisted = {
  windows: WorkspaceWindow[];
  /** 창 id 의 z순서 — 마지막이 포커스(최상단). */
  zOrder: string[];
  groupSymbols: Partial<Record<GroupId, GroupSymbol>>;
};

/**
 * 레이아웃 프리셋 스냅샷 = **창·z순서만**(ADR-0119 PR-E, #713 §5 의 v3 에서 종목을 뺀 형태).
 *
 * `groupSymbols` 가 빠진 것이 이 타입의 요점이다. v3 는 종목까지 담아 적용 시 교체했지만
 * (TradingView 레이아웃 관례), 배치를 바꾸려고 프리셋을 누른 사용자가 보던 종목까지
 * 잃는 것이 실제 사용에서 손해였다. 이제 프리셋은 배치를 담고 종목은 담지 않는다 —
 * `/study` 프리셋과 같은 계약이다(거긴 애초에 탭이 종목의 SSOT 라 담은 적이 없다).
 *
 * 뷰포트·chartRuntime 은 종전대로 비저장(§6).
 */
export type WorkspaceSnapshot = Omit<Persisted, 'groupSymbols'>;

type Store = Persisted & {
  /** 창별 비영속 런타임(팬 백필 from-date 등). 창 닫힘·종목 교체 시 정리. */
  chartRuntime: Record<string, ChartWindowRuntime>;
  /**
   * 레거시 px rect 를 아직 비율로 못 바꾼 상태 — 런타임 전용(영속 안 함).
   * 캔버스가 자기 크기를 처음 실측할 때 `normalizeLegacyRects` 로 해소된다.
   * true 인 동안 rect 값은 **px** 이므로 비율로 해석하면 안 된다(ADR-0122).
   */
  pendingNormalize: boolean;
  /** 레거시 px rect 를 주어진 캔버스 기준 비율로 1회 변환하고 v2 로 영속화. */
  normalizeLegacyRects: (canvas: Canvas) => void;
  addWindow: (kind: WindowKind) => string;
  closeWindow: (id: string) => void;
  focusWindow: (id: string) => void;
  /** 단일 창 rect 커밋(드래그/리사이즈 종료 시). */
  setWindowRect: (id: string, rect: WorkspaceRect) => void;
  /** 여러 창 rect 를 한 번에 커밋(스플리터: 드래그 창 + follower 들). */
  setWindowRects: (updates: readonly { id: string; rect: WorkspaceRect }[]) => void;
  setWindowGroup: (id: string, group: GroupId) => void;
  setGroupSymbol: (group: GroupId, symbol: GroupSymbol) => void;
  /** 실명이 아직 안 붙은(`name === code`) 주식 그룹 종목을 심볼 마스터 실명으로
   *  보강한다. `resolve` 가 undefined 를 주면 그 그룹은 그대로 둔다. */
  backfillSymbolNames: (resolve: (code: string) => string | undefined) => void;

  // ── 차트 창 쓰기 경로 ──
  // 지표 액션은 여기 없다 — 전역 스토어(`livePage`)가 소유하고, 창은 "어느 봉
  // 버킷인가"만 정한다(`windowView` 의 `useIndicatorActions`).
  /** 봉 전환 — livePage setCandleTimeframe 의 창별 미러(분봉 기억·백필 리셋 포함). */
  setChartTimeframe: (id: string, tf: LiveTimeframe) => void;
  /** 좌측 팬 딥 백필의 창별 from-date 확장 — 단조 감소 가드(livePage 미러). */
  extendChartHistoricalRange: (id: string, date: string) => void;
  resetChartHistoricalRange: (id: string) => void;

  /**
   * 프리셋 적용 — **창·배치만** 교체한다(ADR-0119 PR-E 에서 종목 교체를 철회).
   *
   * raw 스냅샷을 readWindow 로 canonical 재정규화해 windows·zOrder 를 교체하고,
   * chartRuntime 을 전체 리셋(fresh-view)한 뒤 persist 한다. 유효 창이 하나도 없으면
   * 공장 기본 배치로 폴백한다(readStorage 폴백과 동일 규율).
   *
   * **`groupSymbols` 는 payload 에서 읽지 않는다** — 어떤 경로로 들어와도(프리셋 적용·
   * 기본 배치 초기화·손상 payload 폴백) 지금 보고 있는 종목이 그대로 남는다. 종목을
   * 바꾸는 문은 `setGroupSymbol` 하나뿐이다.
   *
   * 못 보는 것: 프리셋 창이 지금 종목이 없는 그룹을 쓰면 그 창은 빈 상태로 열린다
   * (공장 기본 워크스페이스와 같은 상태 — 검색으로 종목을 넣으면 채워진다).
   */
  applyWorkspaceSnapshot: (snapshot: unknown) => void;
};

let idCounter = 0;
function newWindowId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `w_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isWindowKind(value: unknown): value is WindowKind {
  return typeof value === 'string' && (WINDOW_KINDS as readonly string[]).includes(value);
}

function isGroupId(value: unknown): value is GroupId {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= MIN_GROUP && value <= MAX_GROUP;
}

function isLiveTimeframe(value: unknown): value is LiveTimeframe {
  return typeof value === 'string' && (LIVE_TIMEFRAMES as readonly string[]).includes(value);
}

function isMinuteFrameValue(value: unknown): value is MinuteTimeframe {
  return typeof value === 'string' && (MINUTE_TIMEFRAMES as readonly string[]).includes(value);
}

/**
 * rect 읽기 — v2 는 비율, v1(레거시)은 px 를 **그대로** 통과시킨다.
 *
 * v1 px 를 여기서 비율로 바꿀 수 없다: 그 px 가 *어떤 캔버스에서* 만들어졌는지
 * 모르기 때문이다(고정 기준으로 나누면 넓은 모니터의 레이아웃이 비율 1 을 넘겨
 * 화면 밖으로 나간다). 변환은 캔버스가 자기 크기를 처음 실측하는 시점으로 미룬다
 * — `normalizeLegacyRects`, ADR-0122.
 */
function readRect(raw: unknown, legacyPx: boolean): WorkspaceRect | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isFiniteNumber(r.x) || !isFiniteNumber(r.y) || !isFiniteNumber(r.w) || !isFiniteNumber(r.h)) {
    return null;
  }
  if (legacyPx) {
    return { x: r.x, y: r.y, w: Math.max(MIN_W, r.w), h: Math.max(MIN_H, r.h) };
  }
  const rect = { x: r.x, y: r.y, w: r.w, h: r.h };
  return isFracRect(rect) ? rect : null;
}

function readWindow(raw: unknown, legacyPx: boolean): WorkspaceWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as Record<string, unknown>;
  if (typeof w.id !== 'string' || !isWindowKind(w.kind) || !isGroupId(w.group)) return null;
  const rect = readRect(w.rect, legacyPx);
  if (!rect) return null;
  const win: WorkspaceWindow = { id: w.id, kind: w.kind, group: w.group, rect };
  if (w.kind === 'chart') {
    const cfg = (w.chart ?? {}) as Record<string, unknown>;
    // 구 스냅샷의 `cfg.indicators` 는 읽지 않는다 — 전역으로 1회 승격된 뒤
    // (`indicatorsWindowMigration`) 다음 저장 때 자연 소멸한다.
    win.chart = {
      timeframe: isLiveTimeframe(cfg.timeframe) ? cfg.timeframe : '1m',
    };
    if (isMinuteFrameValue(cfg.lastMinuteTimeframe)) {
      win.chart.lastMinuteTimeframe = cfg.lastMinuteTimeframe;
    } else if (isMinuteFrameValue(win.chart.timeframe)) {
      // 저장값이 없거나 무효면 현재 분봉에서 파생(livePage 하이드레이션 미러) —
      // 분봉 슬롯 복귀가 '1m' 폴백으로 퇴행하지 않게.
      win.chart.lastMinuteTimeframe = win.chart.timeframe;
    }
  }
  return win;
}

function readGroupSymbols(raw: unknown): Partial<Record<GroupId, GroupSymbol>> {
  const out: Partial<Record<GroupId, GroupSymbol>> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const group = Number(key);
    if (!isGroupId(group) || !val || typeof val !== 'object') continue;
    const s = val as Record<string, unknown>;
    if (typeof s.code === 'string' && typeof s.name === 'string') {
      // kind='index' 는 code 가 실제 LiveIndexId 일 때만 보존 — 손상/외래 값이
      // 상태바 폴백(`index:FOO`)·드로어 capabilities 로 새는 것을 입구에서 차단(리뷰 #2).
      const isIndex = s.kind === 'index' && isLiveIndexId(s.code);
      out[group] = { code: s.code, name: s.name, ...(isIndex ? { kind: 'index' as const } : {}) };
    }
  }
  return out;
}


/** 공장 기본 배치는 `liveDefaultLayout.ts` 소유다 — `workspaceMigration` 과 값을
 *  공유해야 하고, 여기 두면 순환이 된다(그 파일 주석 참조). */
function defaultWindows(): WorkspaceWindow[] {
  return liveDefaultWindows(newWindowId);
}

/** raw 스냅샷 — 자기 탭 저장소가 authoritative. 비어 있으면(새 탭) 공유 시드를
 *  **읽기만 해서** 물려받는다: 사용자가 늘 쓰던 레이아웃 그대로 열리되, 이후 변경은
 *  그 탭에서 시작한다. 시드는 이 시점에 쓰지 않는다(열기만 해서는 아무것도 안 바뀜). */
function readWorkspaceSnapshot(): Record<string, unknown> {
  const own = readJsonObject(WORKSPACE_STORAGE_KEY, 'tab');
  if (Array.isArray(own.windows)) return own;
  return readJsonObject(WORKSPACE_STORAGE_KEY, 'shared');
}

function readStorage(): Persisted & { pendingNormalize: boolean } {
  const parsed = readWorkspaceSnapshot();
  // v2 = 비율 rect(ADR-0122). 버전이 없거나 낮으면 레거시 px — 값은 그대로 싣고
  // pendingNormalize 로 표시해 캔버스 첫 실측 때 비율화한다.
  const legacyPx = parsed.schema_version !== WORKSPACE_SCHEMA_VERSION;
  const rawWindows = Array.isArray(parsed.windows) ? parsed.windows : null;
  if (!rawWindows) {
    // live.workspace.v1 없음 → 레거시 키(live.page/indicators/layout.v1)에서 1회 시드
    // (ADR-0119 PR-C, #713). 마이그레이션할 상태도 없으면 공장 기본 레이아웃.
    // 시드/기본 레이아웃은 **즉시 persist** — 첫 mutation 전 새로고침마다 재시드돼
    // 창 id 가 흔들리는 것을 막는다(C2c-2d, 스펙 ⑤-①).
    //
    // 레거시 시드는 **비율**이다(2026-08-17) → `pendingNormalize: false`. 종전엔 px 를
    // 만들고 `true` 로 넘겼는데, 바로 위 persist 가 그것을 v2(비율)로 태그해 다음 로드에
    // `isFracRect` 가 전량 탈락시켰다 — 마이그레이션이 첫 새로고침에 사라졌다
    // (경위·실측은 `buildWorkspaceSeed` 주석). `pendingNormalize` 자체는 남는다:
    // 진짜 v1 px 저장값을 가진 사용자의 경로가 아래 `legacyPx` 다.
    const seeded = readLegacyWorkspaceSeed(newWindowId);
    if (seeded) {
      persistFromState(seeded);
      return { ...seeded, pendingNormalize: false };
    }
    const windows = defaultWindows();
    const fresh = { windows, zOrder: windows.map((w) => w.id), groupSymbols: {} };
    persistFromState(fresh);
    return { ...fresh, pendingNormalize: false };
  }
  const windows = rawWindows
    .map((w) => readWindow(w, legacyPx))
    .filter((w): w is WorkspaceWindow => w !== null);
  // 저장값이 전부 손상돼 창이 하나도 없으면 기본 레이아웃으로 폴백 — 즉시 persist
  // 로 창 id 를 고정한다(시드/공장 경로와 동일 규율, 리뷰 #5).
  if (windows.length === 0) {
    const fresh = { windows: defaultWindows(), zOrder: [] as string[], groupSymbols: {} };
    fresh.zOrder = fresh.windows.map((w) => w.id);
    persistFromState(fresh);
    return { ...fresh, pendingNormalize: false };
  }
  return {
    windows,
    zOrder: normalizeZOrder(parsed.zOrder, windows),
    groupSymbols: readGroupSymbols(parsed.groupSymbols),
    pendingNormalize: legacyPx,
  };
}

/** 모든 setter 가 공유하는 단일 영속화 지점(liveLayout 패턴).
 *  authoritative 는 자기 탭의 sessionStorage — 다른 탭을 절대 덮어쓰지 않는다.
 *  메인 탭은 같은 페이로드를 공유 키에도 흘려보내 **새 탭의 시드**를 갱신한다(열린
 *  탭은 시드를 읽지 않으므로 탭 간 경합이 아니다). 딥링크 탭은 시드를 갱신하지 않는다. */
function persistFromState(state: Persisted): void {
  const snapshot = {
    schema_version: WORKSPACE_SCHEMA_VERSION,
    windows: state.windows,
    zOrder: state.zOrder,
    groupSymbols: state.groupSymbols,
  };
  persistJson(WORKSPACE_STORAGE_KEY, snapshot, 'tab');
  if (!isDeepLinkTab()) persistJson(WORKSPACE_STORAGE_KEY, snapshot, 'shared');
}

/** 대상 차트 창 = 포커스 창이 차트면 그 창, 아니면 z순서 최상위 차트 창 —
 *  드로어(#712)·상태바/저장뷰 발행·프리셋이 공유하는 대상 선정 규칙. */
export function targetChartWindow(
  windows: readonly WorkspaceWindow[],
  zOrder: readonly string[],
): WorkspaceWindow | null {
  for (let i = zOrder.length - 1; i >= 0; i--) {
    const w = windows.find((win) => win.id === zOrder[i]);
    if (w?.kind === 'chart') return w;
  }
  return null;
}

/** 그룹의 대상 차트 창 = 그 그룹에서 z-최상위 차트 창 (ADR-0119 PR-D) —
 *  그룹 차트 링크(매물대·프로그램 번들·스팟 timeframe) 발행자 선정 규칙.
 *  targetChartWindow(전역 드로어/상태바 대상)와 같은 순회를 그룹으로 좁힌 것. */
export function groupTargetChartWindow(
  windows: readonly WorkspaceWindow[],
  zOrder: readonly string[],
  group: GroupId,
): WorkspaceWindow | null {
  for (let i = zOrder.length - 1; i >= 0; i--) {
    const w = windows.find((win) => win.id === zOrder[i]);
    if (w?.kind === 'chart' && w.group === group) return w;
  }
  return null;
}

/** 포커스 창(zOrder 마지막)의 그룹 = 활성 그룹(#711). 창이 없으면 그룹 1. */
export function activeGroupOf(state: Pick<Persisted, 'windows' | 'zOrder'>): GroupId {
  const focusedId = state.zOrder[state.zOrder.length - 1];
  const focused = state.windows.find((w) => w.id === focusedId);
  return focused?.group ?? 1;
}

/** 포커스 차트 창(없으면 undefined) — 새 차트 창 복제 시드용(#712). */
function focusedChart(state: Persisted): WorkspaceWindow | undefined {
  for (let i = state.zOrder.length - 1; i >= 0; i--) {
    const w = state.windows.find((win) => win.id === state.zOrder[i]);
    if (w?.kind === 'chart') return w;
  }
  return undefined;
}

/**
 * px 로 실측된 기본 크기를 비율로 옮길 때 쓰는 기준 캔버스 (ADR-0122).
 * 1600×900 뷰포트에서 실측한 캔버스 크기 — DEFAULT_SIZE 주석의 px 근거들이
 * 이 캔버스를 전제로 잡혀 있다.
 */

const DEFAULT_SIZE: Record<WindowKind, { w: number; h: number }> = {
  chart: { w: 520, h: 360 },
  // 고정 조성 카드는 첫 표시부터 전부 보이는 높이로 (실데이터 실측 기준):
  // book = 십자 배치(BookPanel). 헤더 27 + 행 22×22(상한 여백 1 + 매도 10 + 매수 10 +
  // 하단 여백 1) + 총잔량바 ~34 ≈ 545 → 560. **높이는 행 수가 정하므로 폭 축소와
  // 무관하게 불변이다.** 폭은 `bookPanelMetrics` 가 SSOT — 680(~2026-07-24) →
  // 600(~2026-08-16) → 480. 두 축소 모두 폰트가 아니라 슬랙을 걷어낸 것으로,
  // 슬랙은 우측 통계의 라벨↔값 간격을 벌려 빈 세로 띠로 나타났다. (WindowFrameCore
  // 본문은 가로 크롬이 없어 창 폭이 곧 패널 폭 — 하한 미만으로 좁히면 가로 스크롤.)
  book: { w: BOOK_WINDOW_DEFAULT_W, h: 560 },
  // broker = 헤더 27 + 시점 상한 10행(매수5+매도5) 23.25×10 + divide 9 ≈ 269 → 280.
  // (하루 누적 유니온은 10행을 넘을 수 있고 그때는 스크롤이 정상.)
  broker: { w: 236, h: 280 },
  // trade = 헤더 27 + 컬럼헤더 22 + 행 23.25×12 ≈ 328 → 330. 체결은 장중 무한히
  // 흐르는 리스트라 "전부 보이는 높이"가 없다 — 시점 상한(12행)까지 보이고 나머지는
  // 스크롤(broker 와 같은 부류). 폭은 4열(시각·체결가·체결량·구분)이라 book 보다 넓다.
  trade: { w: 268, h: 330 },
  vdist: { w: 300, h: 240 },
  // program = 헤더 27 + 카드(py 16 + 타이틀행 ~17 + 금액/수량 그리드 ~51 +
  // 스파크라인 최소 56 + 보간 라벨 ~20) ≈ 187 → 200. 스파크라인이 flex-1 이라
  // 창을 키우면 그래프가 초과분을 흡수한다.
  program: { w: 260, h: 200 },
  // investor = 헤더 27 + thead(text-xs) 30 + KIS 가집계 최대 5차 32.25×5 ≈ 218 → 230.
  // 카드 껍데기(테두리·자체 헤더·좌우 여백)를 걷어내 창 프레임이 그 역할을 하므로
  // 표가 창을 그대로 쓴다 — 2026-07-30 이전의 310 은 그 껍데기까지 세던 값이다.
  //
  // 폭 340 은 **실측 임계 325 위**로 잡은 값이다(2026-08-04, /browse). 수량을 만
  // 단위로 축약하던 시절엔 280 으로 충분했지만, 원수 표기로 바뀌면서 값 셀 하나가
  // -1,925,000 = 73px 를 요구한다. 임계 아래로 내리면 `table-fixed` 라 폭이 재분배되지
  // 않고 **세 컬럼이 조용히 잘린다** — 스크롤바도 생기지 않으므로 눈으로만 잡힌다.
  investor: { w: 340, h: 230 },
  'sector-ranking': { w: 360, h: 320 },
};

const hydrated = readStorage();

/** 차트 창 설정 변경 공통 경로 — 대상이 차트 창일 때만 fn 으로 chart 를 교체한다. */
function withChart(
  state: Pick<Persisted, 'windows'>,
  id: string,
  fn: (chart: ChartWindowConfig) => ChartWindowConfig,
): WorkspaceWindow[] | null {
  const win = state.windows.find((w) => w.id === id);
  if (!win?.chart) return null;
  const chart = fn(win.chart);
  return state.windows.map((w) => (w.id === id ? { ...w, chart } : w));
}

const EMPTY_RUNTIME: ChartWindowRuntime = {
  historicalFromDate: null,
  lastMinuteHistoricalFromDate: null,
};

/** fresh-view 규칙(#711): 종목이 바뀌는(창 닫힘·그룹 이동·그룹 종목 교체) 창들의
 *  비영속 런타임(팬 백필 from-date·분봉 기억)을 걷는다 — 이전 종목의 딥 백필
 *  창이 새 종목으로 새지 않게. 삭제 규칙의 단일 지점(Shotgun Surgery 방지). */
function clearedChartRuntime(
  runtime: Record<string, ChartWindowRuntime>,
  ids: Iterable<string>,
): Record<string, ChartWindowRuntime> {
  const next = { ...runtime };
  for (const id of ids) delete next[id];
  return next;
}

export const useWorkspaceStore = create<Store>((set, get) => ({
  ...hydrated,
  chartRuntime: {},

  addWindow: (kind) => {
    const id = newWindowId();
    set((state) => {
      const group = activeGroupOf(state); // 새 창 = 활성 그룹 상속(#711)
      // DEFAULT_SIZE 는 px 실측값(카드가 전부 보이는 높이) — 기준 캔버스로 나눠
      // 비율로 옮긴다(ADR-0122). 실제 렌더 크기는 그때의 캔버스에 비례한다.
      const size = DEFAULT_SIZE[kind];
      const frac = { w: size.w / REF_CANVAS.w, h: size.h / REF_CANVAS.h };
      // 캐스케이드 오프셋 — 새 창이 서로 겹쳐 나지 않도록 창 수에 비례해 밀어낸다.
      const offPx = 24 + ((state.windows.length * 28) % 200);
      const win: WorkspaceWindow = {
        id,
        kind,
        group,
        rect: {
          x: Math.min(offPx / REF_CANVAS.w, 1 - frac.w),
          y: Math.min(offPx / REF_CANVAS.h, 1 - frac.h),
          ...frac,
        },
      };
      if (kind === 'chart') {
        // 포커스 차트 창의 봉을 물려받는다 — 없으면 공장 기본.
        const src = focusedChart(state);
        win.chart = src?.chart ? { ...src.chart } : { timeframe: '1m' };
      }
      const next = { windows: [...state.windows, win], zOrder: [...state.zOrder, id] };
      persistFromState({ ...state, ...next });
      return next;
    });
    return id;
  },

  closeWindow: (id) => {
    set((state) => {
      const next = {
        windows: state.windows.filter((w) => w.id !== id),
        zOrder: state.zOrder.filter((i) => i !== id),
        chartRuntime: clearedChartRuntime(state.chartRuntime, [id]),
      };
      persistFromState({ ...state, ...next });
      return next;
    });
  },

  focusWindow: (id) => {
    set((state) => {
      if (state.zOrder[state.zOrder.length - 1] === id) return {}; // 이미 최상단 — no-op
      if (!state.windows.some((w) => w.id === id)) return {};
      const zOrder = [...state.zOrder.filter((i) => i !== id), id];
      persistFromState({ ...state, zOrder });
      return { zOrder };
    });
  },

  setWindowRect: (id, rect) => {
    set((state) => {
      const windows = state.windows.map((w) => (w.id === id ? { ...w, rect } : w));
      persistFromState({ ...state, windows });
      return { windows };
    });
  },

  setWindowRects: (updates) => {
    if (updates.length === 0) return;
    const map = new Map(updates.map((u) => [u.id, u.rect]));
    set((state) => {
      const windows = state.windows.map((w) => {
        const rect = map.get(w.id);
        return rect ? { ...w, rect } : w;
      });
      persistFromState({ ...state, windows });
      return { windows };
    });
  },

  setWindowGroup: (id, group) => {
    if (!isGroupId(group)) return;
    set((state) => {
      const prev = state.windows.find((w) => w.id === id);
      if (!prev || prev.group === group) return {};
      const windows = state.windows.map((w) => (w.id === id ? { ...w, group } : w));
      // 그룹 이동 = 이 창의 표시 종목 교체(그룹=종목 SSOT #711) — fresh-view 런타임 리셋.
      persistFromState({ ...state, windows });
      return { windows, chartRuntime: clearedChartRuntime(state.chartRuntime, [id]) };
    });
  },

  setGroupSymbol: (group, symbol) => {
    if (!isGroupId(group)) return;
    set((state) => {
      const groupSymbols = { ...state.groupSymbols, [group]: symbol };
      // 종목 교체 = fresh-view — 그 그룹 창들의 백필·분봉 기억 런타임 리셋.
      const affected = state.windows.filter((w) => w.group === group).map((w) => w.id);
      persistFromState({ ...state, groupSymbols });
      return { groupSymbols, chartRuntime: clearedChartRuntime(state.chartRuntime, affected) };
    });
  },

  /** 라벨 수정 전용 — `setGroupSymbol` 과 달리 **chartRuntime 을 건드리지 않는다**.
   *
   *  종목 교체(setGroupSymbol)는 fresh-view 라 백필 from-date·분봉 기억을 리셋하지만,
   *  실명 보강은 같은 종목의 표시 문자열만 바꾸는 것이다. 여기서 리셋하면 심볼 마스터
   *  응답이 도착하는 임의의 시점에 진행 중이던 과거 백필이 조용히 처음으로 되감긴다.
   *
   *  판정은 `name === code` 하나로 한다 — 라벨 없이 저장된 값의 유일한 서명이다
   *  (liveNavigate 의 `label ?? code` 폴백). 지수는 code 가 곧 사람이 읽는 id 라
   *  심볼 마스터에 없고, 보강 대상도 아니므로 건너뛴다. */
  backfillSymbolNames: (resolve) => {
    set((state) => {
      let groupSymbols: Partial<Record<GroupId, GroupSymbol>> | null = null;
      for (const [key, symbol] of Object.entries(state.groupSymbols)) {
        if (!symbol || symbol.kind === 'index' || symbol.name !== symbol.code) continue;
        const name = resolve(symbol.code);
        if (!name || name === symbol.code) continue;
        groupSymbols ??= { ...state.groupSymbols };
        groupSymbols[Number(key) as GroupId] = { ...symbol, name };
      }
      // 보강할 게 없으면 참조를 그대로 둔다 — persist·재렌더 낭비 회피(매 심볼 마스터
      // 재검증마다 불리는 경로다).
      if (!groupSymbols) return {};
      persistFromState({ ...state, groupSymbols });
      return { groupSymbols };
    });
  },

  normalizeLegacyRects: (canvas) => {
    set((state) => {
      if (!state.pendingNormalize) return {};
      // 레거시 px → 지금 이 캔버스 기준 비율. 사용자가 보고 있는 화면으로 나누므로
      // 변환 직후 배치는 눈에 보이는 변화가 없다(ADR-0122).
      const windows = state.windows.map((w) => ({ ...w, rect: toFrac(w.rect as Rect, canvas) }));
      persistFromState({ ...state, windows });
      return { windows, pendingNormalize: false };
    });
  },

  setChartTimeframe: (id, tf) => {
    if (!isLiveTimeframe(tf)) return;
    set((state) => {
      const prev = state.windows.find((w) => w.id === id)?.chart;
      if (!prev) return {};
      const windows = withChart(state, id, (chart) => ({
        ...chart,
        timeframe: tf,
        ...(isMinuteTimeframe(tf) ? { lastMinuteTimeframe: tf } : {}),
      }));
      if (!windows) return {};
      // 분봉을 떠나는 순간의 pan 창 기억 + 백필 리셋(livePage setCandleTimeframe
      // 미러 — `??` 폴백 의미는 livePage 주석 참조).
      const rt = state.chartRuntime[id] ?? EMPTY_RUNTIME;
      const chartRuntime = {
        ...state.chartRuntime,
        [id]: {
          historicalFromDate: null,
          lastMinuteHistoricalFromDate: isMinuteTimeframe(prev.timeframe)
            ? rt.historicalFromDate ?? rt.lastMinuteHistoricalFromDate
            : rt.lastMinuteHistoricalFromDate,
        },
      };
      persistFromState({ ...state, windows });
      return { windows, chartRuntime };
    });
  },

  extendChartHistoricalRange: (id, date) => {
    const state = get();
    if (!state.windows.some((w) => w.id === id && w.chart)) return;
    const rt = state.chartRuntime[id] ?? EMPTY_RUNTIME;
    if (rt.historicalFromDate !== null && rt.historicalFromDate <= date) return; // 단조 감소 가드
    set({
      chartRuntime: {
        ...state.chartRuntime,
        [id]: { ...rt, historicalFromDate: date },
      },
    });
  },

  resetChartHistoricalRange: (id) => {
    set((state) => {
      if (!(id in state.chartRuntime)) return {};
      return { chartRuntime: clearedChartRuntime(state.chartRuntime, [id]) };
    });
  },

  applyWorkspaceSnapshot: (snapshot) => {
    set((state) => {
      // 종목은 payload 를 보지 않고 현재 것을 그대로 넘긴다 — 폴백 분기까지 한 규칙.
      const next = { ...normalizeWorkspaceSnapshot(snapshot), groupSymbols: state.groupSymbols };
      persistFromState(next);
      // 창이 통째로 갈리며 id 도 프리셋 것으로 바뀐다 → 창에 매인 비영속 런타임은
      // 가리킬 창이 없어진다. 종목이 유지돼도 이 리셋은 그대로 필요하다(fresh-view).
      return { ...next, chartRuntime: {} };
    });
  },
}));

/** 현재 워크스페이스를 프리셋 스냅샷으로 캡처한다(뷰포트·런타임 제외).
 *  스토어 내부 참조를 잡지 않도록 창·rect·chart 값까지 새 객체로 복제한다 —
 *  프리셋 저장·비교가 나중의 스토어 변이에 오염되지 않게.
 *
 *  담기지 않는 것 둘: **종목**(프리셋은 배치만 — `WorkspaceSnapshot` 주석)과
 *  **지표**(전역 1세트라 창에 실을 것이 없다). 창의 group 번호는 배치의 일부라
 *  남지만, 그 번호가 어느 종목인지는 프리셋 밖의 현재 상태가 정한다. */
export function snapshotWorkspace(): WorkspaceSnapshot {
  const s = useWorkspaceStore.getState();
  return {
    windows: s.windows.map((w) => ({
      ...w,
      rect: { ...w.rect },
      ...(w.chart ? { chart: { ...w.chart } } : {}),
    })),
    zOrder: [...s.zOrder],
  };
}

/** raw 스냅샷(프리셋 payload)을 canonical 창·z순서로 재정규화한다 — readStorage 와
 *  같은 검증 경로(readWindow/normalizeZOrder) 재사용. 유효 창이 없으면 공장 기본
 *  배치로 폴백(빈 워크스페이스로 덮어써 창을 잃지 않게).
 *
 *  **`groupSymbols` 는 읽지 않는다** — 반환 타입에서 빠져 있으므로, 옛 payload 에
 *  종목이 남아 있어도(v3 로 저장된 프리셋) 여기서 조용히 버려진다. 폴백 분기가
 *  종목을 지우지 못하는 것도 같은 이유다(그 분기가 `groupSymbols: {}` 를 만들던 것이
 *  "기본 배치로 초기화" 에서 종목을 날리던 경로였다). */
function normalizeWorkspaceSnapshot(raw: unknown): WorkspaceSnapshot {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawWindows = Array.isArray(obj.windows) ? obj.windows : [];
  // 프리셋 payload 는 v2(비율)만 인정한다 — 스키마 v3 로 저장된 구 px 페이로드는
  // rect 검증에서 떨어져 공장 기본으로 폴백한다(ADR-0122). 프리셋은 이미
  // 버전 불일치 시 폐기하는 규율이라 조용한 오해석보다 이쪽이 안전하다.
  const windows = rawWindows
    .map((w) => readWindow(w, false))
    .filter((w): w is WorkspaceWindow => w !== null);
  if (windows.length === 0) {
    const fallback = defaultWindows();
    return { windows: fallback, zOrder: fallback.map((w) => w.id) };
  }
  return { windows, zOrder: normalizeZOrder(obj.zOrder, windows) };
}
