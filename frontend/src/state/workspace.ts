import { create } from 'zustand';
import { persistJson, readJsonObject } from './persist';
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
import { tidyLayout } from '../live/workspace/tidy';
import { MIN_W, MIN_H, type Canvas, type Rect } from '../live/workspace/snapEngine';
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

/** 창 종류. 'chart' 만 캔들+지표 스택, 나머지는 데이터 창(#708).
 *  'sector-ranking' 은 지수 그룹 전용 데이터 창(ADR-0119 PR-D). */
export const WINDOW_KINDS = ['chart', 'book', 'broker', 'vdist', 'program', 'investor', 'sector-ranking'] as const;
export type WindowKind = (typeof WINDOW_KINDS)[number];

export const MIN_GROUP = 1;
export const MAX_GROUP = 10;
/** 링크 그룹 = 종목 SSOT (#711). 1..10. */
export type GroupId = number;

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

function readRect(raw: unknown): WorkspaceRect | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isFiniteNumber(r.x) || !isFiniteNumber(r.y) || !isFiniteNumber(r.w) || !isFiniteNumber(r.h)) {
    return null;
  }
  return { x: r.x, y: r.y, w: Math.max(MIN_W, r.w), h: Math.max(MIN_H, r.h) };
}

function readWindow(raw: unknown): WorkspaceWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as Record<string, unknown>;
  if (typeof w.id !== 'string' || !isWindowKind(w.kind) || !isGroupId(w.group)) return null;
  const rect = readRect(w.rect);
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

/** 차트 창 하나 — 첫 로드 기본 레이아웃(현행 화면의 최소 재현; PR-C 가 마이그레이션으로 대체). */
function defaultWindows(): WorkspaceWindow[] {
  return [
    {
      id: newWindowId(),
      kind: 'chart',
      group: 1,
      rect: { x: 16, y: 16, w: 720, h: 760 },
      chart: { timeframe: '1m', indicators: normalizeIndicatorsV2({}) },
    },
    // book 높이는 DEFAULT_SIZE.book 과 같은 이유(10호가 20단계+총잔량바 완전 표시)로 530;
    // broker 는 차트 하단(y 776)에 정렬되도록 나머지를 갖는다(누적 유니온 리스트라 스크롤 정상).
    { id: newWindowId(), kind: 'book', group: 1, rect: { x: 748, y: 16, w: 236, h: 530 } },
    { id: newWindowId(), kind: 'broker', group: 1, rect: { x: 748, y: 558, w: 236, h: 218 } },
  ];
}

function readStorage(): Persisted {
  const parsed = readJsonObject(WORKSPACE_STORAGE_KEY);
  const rawWindows = Array.isArray(parsed.windows) ? parsed.windows : null;
  if (!rawWindows) {
    // live.workspace.v1 없음 → 레거시 키(live.page/indicators/layout.v1)에서 1회 시드
    // (ADR-0119 PR-C, #713). 마이그레이션할 상태도 없으면 공장 기본 레이아웃.
    // 시드/기본 레이아웃은 **즉시 persist** — 첫 mutation 전 새로고침마다 재시드돼
    // 창 id 가 흔들리는 것을 막는다(C2c-2d, 스펙 ⑤-①).
    const seeded = readLegacyWorkspaceSeed(newWindowId);
    const fresh = seeded ?? (() => {
      const windows = defaultWindows();
      return { windows, zOrder: windows.map((w) => w.id), groupSymbols: {} };
    })();
    persistFromState(fresh);
    return fresh;
  }
  const windows = rawWindows.map(readWindow).filter((w): w is WorkspaceWindow => w !== null);
  // 저장값이 전부 손상돼 창이 하나도 없으면 기본 레이아웃으로 폴백 — 즉시 persist
  // 로 창 id 를 고정한다(시드/공장 경로와 동일 규율, 리뷰 #5).
  if (windows.length === 0) {
    const fresh = { windows: defaultWindows(), zOrder: [] as string[], groupSymbols: {} };
    fresh.zOrder = fresh.windows.map((w) => w.id);
    persistFromState(fresh);
    return fresh;
  }
  return {
    windows,
    zOrder: normalizeZOrder(parsed.zOrder, windows),
    groupSymbols: readGroupSymbols(parsed.groupSymbols),
  };
}

/** 모든 setter 가 공유하는 단일 영속화 지점(liveLayout 패턴). */
function persistFromState(state: Persisted): void {
  persistJson(WORKSPACE_STORAGE_KEY, {
    windows: state.windows,
    zOrder: state.zOrder,
    groupSymbols: state.groupSymbols,
  });
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

const DEFAULT_SIZE: Record<WindowKind, { w: number; h: number }> = {
  chart: { w: 520, h: 360 },
  // 고정 조성 카드는 첫 표시부터 전부 보이는 높이로 (실데이터 실측 기준):
  // book = 헤더 27(26+보더 1) + 행 23.25×20 + 구분선 1 + 총잔량바 28.75 ≈ 522 → 여유 포함 530.
  book: { w: 236, h: 530 },
  // broker = 헤더 27 + 시점 상한 10행(매수5+매도5) 23.25×10 + divide 9 ≈ 269 → 280.
  // (하루 누적 유니온은 10행을 넘을 수 있고 그때는 스크롤이 정상.)
  broker: { w: 236, h: 280 },
  vdist: { w: 300, h: 240 },
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
      const size = DEFAULT_SIZE[kind];
      // 캐스케이드 오프셋 — 새 창이 서로 겹쳐 나지 않도록 창 수에 비례해 밀어낸다.
      const off = 24 + ((state.windows.length * 28) % 200);
      const win: WorkspaceWindow = {
        id,
        kind,
        group,
        rect: { x: off, y: off, ...size },
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

  tidyAll: (canvas) => {
    set((state) => {
      const layout = tidyLayout(
        state.windows.map((w) => ({ id: w.id, isChart: w.kind === 'chart' })),
        canvas,
      );
      const windows = state.windows.map((w) => {
        const rect = layout.get(w.id);
        return rect ? { ...w, rect: rect as Rect } : w;
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
  const windows = rawWindows.map(readWindow).filter((w): w is WorkspaceWindow => w !== null);
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
