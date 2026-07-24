import { create } from 'zustand';
import { persistJson, readJsonObject, type StorageScope } from './persist';
import {
  normalizeIndicatorsV2,
  type IndicatorSettings,
  type PersistedIndicatorsV2,
} from './indicatorSettingsV2';
import {
  LIVE_TIMEFRAMES,
  MINUTE_TIMEFRAMES,
  isMinuteTimeframe,
  type LiveTimeframe,
  type MinuteTimeframe,
} from './livePage';
import { normalizePaneOrder, normalizePaneStretch, type PaneStretchMap } from '../chart/paneOrder';
import type { PaneId } from '../chart/drawing/types';
import { profileKeyForTimeframe } from '../live/indicators/indicatorPaneProfiles';
import { applyPresetEnableByTimeframe } from './indicatorPresetOps';
import type { PresetEnableByTimeframe } from '../live/presets/presetFlags';
import { tidyLayout } from '../workspace/tidy';
import { MIN_W, MIN_H, type Canvas, type Rect } from '../workspace/snapEngine';
import { isFracRect, toFrac } from '../workspace/rectSpace';
import { readLegacyWorkspaceSeed } from './workspaceMigration';
import { isLiveIndexId } from '../live/liveInstrument';

/**
 * `/live` 멀티창 워크스페이스 상태 (ADR-0119, 스펙 #715).
 *
 * 창(차트·데이터)의 목록·배치·z순서와 링크 그룹→종목 매핑을 소유하고
 * `live.workspace.v1` 로 영속한다. 활성 그룹은 포커스 창(zOrder 마지막)에서
 * 파생하므로 저장하지 않는다(#711). PR-A 는 스캐폴딩 — 실제 차트/데이터 창
 * 배선과 구 키 마이그레이션은 PR-B/C 에서 붙는다.
 */

export const WORKSPACE_STORAGE_KEY = 'live.workspace.v1';
/** 2 = rect 가 캔버스 대비 비율(ADR-0122). 없거나 낮으면 레거시 px 로 읽고 지연 비율화. */
export const WORKSPACE_SCHEMA_VERSION = 2;

/** 딥링크(`/live?code=`·`?index=`)로 열린 탭은 워크스페이스를 sessionStorage 에 둔다.
 *
 *  이유: `persistFromState` 는 바뀐 필드가 아니라 **그 탭의 인메모리 스냅샷 전체**를
 *  쓴다(호출부 20여 곳이 전부 `{...state, 바뀐것}` 패턴). 두 탭이 같은 localStorage
 *  키를 공유하면, 오래된 탭에서 종목과 무관한 조작 하나(예: 보조지표 토글)만 해도
 *  다른 탭의 종목·봉·레이아웃이 통째로 되돌아간다. 두 탭 화면은 각자 자기 메모리를
 *  계속 보여주므로 **조용히** 깨지고, 손실은 다음 새로고침에야 드러난다.
 *  sessionStorage 는 탭마다 독립이라 이 경합을 구조적으로 없앤다.
 *
 *  대가: 딥링크 탭에서 바꾼 레이아웃은 탭을 닫으면 사라진다 — "새 탭 = 곁눈질용
 *  조회 창" 계약. 메인 탭(쿼리 없는 `/live`)은 종전대로 localStorage 를 쓴다.
 *
 *  탭 수명 동안 고정한다(모듈 로드 1회 결정). `readStorage()` 가 모듈 초기화 시점에
 *  실행되므로 그보다 늦게 정해지면 하이드레이션이 틀린 저장소를 읽는다. SPA 내에서
 *  `/study` 를 거쳐 `/live` 로 돌아와도 스코프가 흔들리지 않는 것도 같은 이유. */
function detectWorkspaceScope(): StorageScope {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.has('code') || params.has('index') ? 'tab' : 'shared';
  } catch {
    return 'shared';
  }
}

let scopeCache: StorageScope | null = null;

function workspaceScope(): StorageScope {
  scopeCache ??= detectWorkspaceScope();
  return scopeCache;
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
 * 나가지 않는다. px 계산이 필요한 쪽(snapEngine·tidy·드래그)은 `rectSpace` 의
 * toPx/toFrac 으로 캔버스에서 변환한다 — 스토어는 px 를 모른다.
 */
export interface WorkspaceRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 차트 창 전용 설정 — 창이 소유(#712). timeframe 은 창별 독립(#708). */
export interface ChartWindowConfig {
  timeframe: LiveTimeframe;
  indicators: PersistedIndicatorsV2;
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

/** 레이아웃 프리셋 v3 스냅샷(ADR-0119 PR-E, #713 §5) = Persisted 3필드.
 *  뷰포트·chartRuntime 은 비저장(§6). 프리셋이 이 스냅샷을 통째로 저장/복원한다. */
export type WorkspaceSnapshot = Persisted;

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
  tidyAll: (canvas: Canvas) => void;

  // ── 차트 창 지표 쓰기 경로 (ADR-0119 C2c-2a, #712 창 소유 설정) ──
  /** 대상 창의 "현재 봉" 버킷에 patch 를 누적한다(livePage patchIndicators 미러 —
   *  sparse 정리는 로드 시 normalize 가 담당). 차트 창이 아니면 no-op. */
  patchChartIndicators: (id: string, patch: Partial<IndicatorSettings>) => void;
  /** 명시한 봉 버킷에 patch — pane 토글(setPanePrefForTimeframe)의 전역 시맨틱
   *  미러(전역은 인자 tf 버킷에 기록). 창 tf 와 같으면 patchChartIndicators 동치. */
  patchChartIndicatorsAt: (id: string, timeframe: LiveTimeframe, patch: Partial<IndicatorSettings>) => void;
  /** 봉 전환 — livePage setCandleTimeframe 의 창별 미러(분봉 기억·백필 리셋 포함). */
  setChartTimeframe: (id: string, tf: LiveTimeframe) => void;
  setChartPaneOrder: (id: string, order: PaneId[]) => void;
  setChartPaneStretch: (id: string, patch: PaneStretchMap) => void;
  /** 현재 봉 버킷만 공장값으로(#697 미러). 레이아웃은 보존. */
  resetChartIndicators: (id: string) => void;
  applyChartIndicatorPreset: (id: string, preset: {
    paneOrder: PaneId[];
    byTimeframeEnable: PresetEnableByTimeframe;
    paneStretch: PaneStretchMap;
  }) => void;
  /** 좌측 팬 딥 백필의 창별 from-date 확장 — 단조 감소 가드(livePage 미러). */
  extendChartHistoricalRange: (id: string, date: string) => void;
  resetChartHistoricalRange: (id: string) => void;

  /** 프리셋 v3 적용 — 워크스페이스 통째 교체(ADR-0119 PR-E). raw 스냅샷을
   *  readWindow/readGroupSymbols 로 canonical 재정규화 후 windows·zOrder·
   *  groupSymbols 교체 + chartRuntime 전체 리셋(fresh-view) + persist. 유효 창이
   *  하나도 없으면 공장 기본으로 폴백(readStorage 폴백과 동일 규율). */
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
    win.chart = {
      timeframe: isLiveTimeframe(cfg.timeframe) ? cfg.timeframe : '1m',
      indicators: normalizeIndicatorsV2(cfg.indicators),
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

/** zOrder 를 실제 창 id 집합에 맞춰 정규화(unknown 드롭, 누락 append). */
function normalizeZOrder(raw: unknown, windows: readonly WorkspaceWindow[]): string[] {
  const ids = new Set(windows.map((w) => w.id));
  const seen = new Set<string>();
  const next: string[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === 'string' && ids.has(entry) && !seen.has(entry)) {
        seen.add(entry);
        next.push(entry);
      }
    }
  }
  for (const w of windows) {
    if (!seen.has(w.id)) next.push(w.id);
  }
  return next;
}

/**
 * 첫 로드 기본 레이아웃 — 비율(ADR-0122). 기존 px 기본값(1546×776 캔버스 기준
 * 차트 720×760 / book 680×560 / broker 680×188)을 그 캔버스로 나눈 값이라
 * 어느 화면 크기에서도 같은 배치로 열린다.
 *
 * **단, 우측 열은 REF 유래 비율(0.4398)을 쓰지 않는다.** REF 캔버스(1546)는 실제
 * 캔버스보다 넓어서(1280 뷰포트 실측 1226×531) 그 비율이 `BookPanel` 의 절대
 * 계약인 `min-w 560px` 를 못 채운다 — 0.4398 × 1226 = 539px 로 21px 모자라 가로
 * 스크롤이 생기고 우측 요약 열이 잘린다("시작 58,000" 이 "시작 58" 로 보인다).
 * 비율 좌표계는 절대 하한을 표현하지 못하므로(ADR-0122), 하한이 있는 창의 비율은
 * **REF 가 아니라 좁은 쪽 실측에서 역산**해야 한다.
 *
 * 우측 여백(기존 0.0764)이 놀고 있었으므로 차트는 그대로 두고 그 여백을 우측 열에
 * 준다 — 좌측 여백(0.0104)과 대칭이 되고, 1226 캔버스에서 620px 로 계약을 넘긴다.
 */
const DEFAULT_RIGHT_COL_X = 0.4838;
/** 우측 열 폭 — 우측 여백을 좌측(0.0104)과 대칭으로 남긴 나머지 전부. */
const DEFAULT_RIGHT_COL_W = 1 - DEFAULT_RIGHT_COL_X - 0.0104;

function defaultWindows(): WorkspaceWindow[] {
  return [
    {
      id: newWindowId(),
      kind: 'chart',
      group: 1,
      rect: { x: 0.0104, y: 0.0206, w: 0.4657, h: 0.9794 },
      chart: { timeframe: '1m', indicators: normalizeIndicatorsV2({}) },
    },
    // book 은 십자 배치(BookPanel)라 좁으면 못 담는다 — 차트 오른쪽 절반의 위쪽.
    {
      id: newWindowId(),
      kind: 'book',
      group: 1,
      rect: { x: DEFAULT_RIGHT_COL_X, y: 0.0206, w: DEFAULT_RIGHT_COL_W, h: 0.7216 },
    },
    {
      id: newWindowId(),
      kind: 'broker',
      group: 1,
      rect: { x: DEFAULT_RIGHT_COL_X, y: 0.7577, w: DEFAULT_RIGHT_COL_W, h: 0.2423 },
    },
  ];
}

/** 스코프에 맞는 raw 스냅샷. 딥링크 탭은 자기 sessionStorage 가 비어 있으면 공유
 *  워크스페이스를 **읽기만 해서** 1회 시드한다 — 사용자가 늘 쓰던 레이아웃 그대로
 *  열리되, 이후 변경은 그 탭에만 남는다(공유 키는 이 시점에도 쓰지 않는다). */
function readWorkspaceSnapshot(): Record<string, unknown> {
  if (workspaceScope() === 'tab') {
    const own = readJsonObject(WORKSPACE_STORAGE_KEY, 'tab');
    if (Array.isArray(own.windows)) return own;
    return readJsonObject(WORKSPACE_STORAGE_KEY, 'shared');
  }
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
    // 레거시 시드는 px 를 만들어낸다 — 비율화 대기 상태로 넘긴다.
    const seeded = readLegacyWorkspaceSeed(newWindowId);
    if (seeded) {
      persistFromState(seeded);
      return { ...seeded, pendingNormalize: true };
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
 *  스코프가 'tab' 이면 sessionStorage 로만 나가므로 다른 탭을 덮어쓰지 않는다. */
function persistFromState(state: Persisted): void {
  persistJson(
    WORKSPACE_STORAGE_KEY,
    {
      schema_version: WORKSPACE_SCHEMA_VERSION,
      windows: state.windows,
      zOrder: state.zOrder,
      groupSymbols: state.groupSymbols,
    },
    workspaceScope(),
  );
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
const REF_CANVAS = { w: 1546, h: 776 };

const DEFAULT_SIZE: Record<WindowKind, { w: number; h: number }> = {
  chart: { w: 520, h: 360 },
  // 고정 조성 카드는 첫 표시부터 전부 보이는 높이로 (실데이터 실측 기준):
  // book = 십자 배치(BookPanel). 헤더 27 + 행 22×22(상한 여백 1 + 매도 10 + 매수 10 +
  // 하단 여백 1) + 총잔량바 ~34 ≈ 545 → 560. 폭 = BookPanel 의 min-w 560 +
  // 세로 스크롤바·서브픽셀 여유 ~40 = 600. (WindowFrameCore 본문은 가로 크롬이
  // 없어 창 폭이 곧 패널 폭 — 기존 680은 슬랙 ~120px 이 우측 통계 라벨↔값 간격을
  // 벌려 빈 세로 띠를 만들었다. 2026-07-24 축소. 560 미만으로만 좁히면 패널이
  // 가로 스크롤된다.)
  book: { w: 600, h: 560 },
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
  // investor = 헤더 27 + 카드(헤더 36 + thead 32.25 + KIS 가집계 최대 5차 32.25×5 + 푸터 35) ≈ 303 → 310.
  investor: { w: 280, h: 310 },
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
        // 포커스 차트 창 복제(#712) — 없으면 공장 기본. indicators 는 normalize 로
        // 신선한 사본을 만든다(참조 공유 금지 — 창은 설정을 독립 소유, PR-C 편집 누출 방지).
        const src = focusedChart(state);
        win.chart = src?.chart
          ? {
              timeframe: src.chart.timeframe,
              indicators: normalizeIndicatorsV2(src.chart.indicators),
              ...(src.chart.lastMinuteTimeframe
                ? { lastMinuteTimeframe: src.chart.lastMinuteTimeframe }
                : {}),
            }
          : { timeframe: '1m', indicators: normalizeIndicatorsV2({}) };
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

  tidyAll: (canvas) => {
    set((state) => {
      const layout = tidyLayout(
        state.windows.map((w) => ({ id: w.id, isChart: w.kind === 'chart' })),
        canvas,
      );
      // tidyLayout 은 px 로 계산한다(순수 배치 알고리즘 무변경) — 커밋만 비율로.
      const windows = state.windows.map((w) => {
        const rect = layout.get(w.id);
        return rect ? { ...w, rect: toFrac(rect, canvas) } : w;
      });
      persistFromState({ ...state, windows });
      return { windows };
    });
  },

  patchChartIndicators: (id, patch) => {
    get().patchChartIndicatorsAt(
      id,
      get().windows.find((w) => w.id === id)?.chart?.timeframe ?? '1m',
      patch,
    );
  },

  patchChartIndicatorsAt: (id, timeframe, patch) => {
    set((state) => {
      const windows = withChart(state, id, (chart) => {
        const profileKey = profileKeyForTimeframe(timeframe);
        const bucket = { ...(chart.indicators.byTimeframe[profileKey] ?? {}), ...patch };
        return {
          ...chart,
          indicators: {
            ...chart.indicators,
            byTimeframe: { ...chart.indicators.byTimeframe, [profileKey]: bucket },
          },
        };
      });
      if (!windows) return {};
      persistFromState({ ...state, windows });
      return { windows };
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

  setChartPaneOrder: (id, order) => {
    set((state) => {
      const windows = withChart(state, id, (chart) => ({
        ...chart,
        indicators: { ...chart.indicators, paneOrder: normalizePaneOrder(order) },
      }));
      if (!windows) return {};
      persistFromState({ ...state, windows });
      return { windows };
    });
  },

  setChartPaneStretch: (id, patch) => {
    set((state) => {
      const windows = withChart(state, id, (chart) => ({
        ...chart,
        indicators: {
          ...chart.indicators,
          paneStretch: normalizePaneStretch({ ...chart.indicators.paneStretch, ...patch }),
        },
      }));
      if (!windows) return {};
      persistFromState({ ...state, windows });
      return { windows };
    });
  },

  resetChartIndicators: (id) => {
    set((state) => {
      const windows = withChart(state, id, (chart) => {
        const profileKey = profileKeyForTimeframe(chart.timeframe);
        const byTimeframe = { ...chart.indicators.byTimeframe };
        delete byTimeframe[profileKey];
        return { ...chart, indicators: { ...chart.indicators, byTimeframe } };
      });
      if (!windows) return {};
      persistFromState({ ...state, windows });
      return { windows };
    });
  },

  applyChartIndicatorPreset: (id, preset) => {
    set((state) => {
      const windows = withChart(state, id, (chart) => ({
        ...chart,
        indicators: {
          paneOrder: normalizePaneOrder(preset.paneOrder),
          paneStretch: normalizePaneStretch(preset.paneStretch),
          byTimeframe: applyPresetEnableByTimeframe(
            chart.indicators.byTimeframe,
            preset.byTimeframeEnable,
          ),
        },
      }));
      if (!windows) return {};
      persistFromState({ ...state, windows });
      return { windows };
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
    const next = normalizeWorkspaceSnapshot(snapshot);
    set(() => {
      persistFromState(next);
      // 프리셋 적용 = 창·종목 전면 교체 → 모든 비영속 런타임을 걷는다(fresh-view).
      return { ...next, chartRuntime: {} };
    });
  },
}));

/** 현재 워크스페이스를 프리셋 v3 스냅샷으로 캡처한다(뷰포트·런타임 제외).
 *  스토어 내부 참조를 잡지 않도록 창·rect·chart(indicators normalize)·groupSymbols
 *  값까지 새 객체로 복제한다 — 프리셋 저장·비교가 나중의 스토어 변이에 오염되지 않게. */
export function snapshotWorkspace(): WorkspaceSnapshot {
  const s = useWorkspaceStore.getState();
  const groupSymbols: Partial<Record<GroupId, GroupSymbol>> = {};
  for (const [g, sym] of Object.entries(s.groupSymbols)) {
    if (sym) groupSymbols[Number(g) as GroupId] = { ...sym };
  }
  return {
    windows: s.windows.map((w) => ({
      ...w,
      rect: { ...w.rect },
      ...(w.chart ? { chart: { ...w.chart, indicators: normalizeIndicatorsV2(w.chart.indicators) } } : {}),
    })),
    zOrder: [...s.zOrder],
    groupSymbols,
  };
}

/** raw 스냅샷(프리셋 payload)을 canonical Persisted 로 재정규화한다 — readStorage 와
 *  같은 검증 경로(readWindow/readGroupSymbols/normalizeZOrder) 재사용. 유효 창이
 *  없으면 공장 기본으로 폴백(빈 워크스페이스로 덮어써 창을 잃지 않게). */
function normalizeWorkspaceSnapshot(raw: unknown): Persisted {
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
    return { windows: fallback, zOrder: fallback.map((w) => w.id), groupSymbols: {} };
  }
  return {
    windows,
    zOrder: normalizeZOrder(obj.zOrder, windows),
    groupSymbols: readGroupSymbols(obj.groupSymbols),
  };
}
