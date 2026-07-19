import { create } from 'zustand';
import { persistJson, readJsonObject } from './persist';
import { normalizeIndicatorsV2, type PersistedIndicatorsV2 } from './indicatorSettingsV2';
import { LIVE_TIMEFRAMES, type LiveTimeframe } from './livePage';
import { tidyLayout } from '../live/workspace/tidy';
import { MIN_W, MIN_H, type Canvas, type Rect } from '../live/workspace/snapEngine';

/**
 * `/live` 멀티창 워크스페이스 상태 (ADR-0119, 스펙 #715).
 *
 * 창(차트·데이터)의 목록·배치·z순서와 링크 그룹→종목 매핑을 소유하고
 * `live.workspace.v1` 로 영속한다. 활성 그룹은 포커스 창(zOrder 마지막)에서
 * 파생하므로 저장하지 않는다(#711). PR-A 는 스캐폴딩 — 실제 차트/데이터 창
 * 배선과 구 키 마이그레이션은 PR-B/C 에서 붙는다.
 */

export const WORKSPACE_STORAGE_KEY = 'live.workspace.v1';

/** 창 종류. 'chart' 만 캔들+지표 스택, 나머지는 데이터 창(#708). */
export const WINDOW_KINDS = ['chart', 'book', 'broker', 'vdist', 'program', 'investor'] as const;
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
  code: string;
  name: string;
}

type Persisted = {
  windows: WorkspaceWindow[];
  /** 창 id 의 z순서 — 마지막이 포커스(최상단). */
  zOrder: string[];
  groupSymbols: Partial<Record<GroupId, GroupSymbol>>;
};

type Store = Persisted & {
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
      out[group] = { code: s.code, name: s.name };
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
    { id: newWindowId(), kind: 'book', group: 1, rect: { x: 748, y: 16, w: 236, h: 470 } },
    { id: newWindowId(), kind: 'broker', group: 1, rect: { x: 748, y: 498, w: 236, h: 278 } },
  ];
}

function readStorage(): Persisted {
  const parsed = readJsonObject(WORKSPACE_STORAGE_KEY);
  const rawWindows = Array.isArray(parsed.windows) ? parsed.windows : null;
  if (!rawWindows) {
    const windows = defaultWindows();
    return { windows, zOrder: windows.map((w) => w.id), groupSymbols: {} };
  }
  const windows = rawWindows.map(readWindow).filter((w): w is WorkspaceWindow => w !== null);
  // 저장값이 전부 손상돼 창이 하나도 없으면 기본 레이아웃으로 폴백.
  if (windows.length === 0) {
    const fresh = defaultWindows();
    return { windows: fresh, zOrder: fresh.map((w) => w.id), groupSymbols: {} };
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
  book: { w: 236, h: 440 },
  broker: { w: 236, h: 220 },
  vdist: { w: 300, h: 240 },
  program: { w: 260, h: 200 },
  investor: { w: 280, h: 220 },
};

const hydrated = readStorage();

export const useWorkspaceStore = create<Store>((set) => ({
  ...hydrated,

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
        // 포커스 차트 창 복제(#712) — 없으면 공장 기본.
        const src = focusedChart(state);
        win.chart = src?.chart
          ? { timeframe: src.chart.timeframe, indicators: src.chart.indicators }
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
      const windows = state.windows.map((w) => (w.id === id ? { ...w, group } : w));
      persistFromState({ ...state, windows });
      return { windows };
    });
  },

  setGroupSymbol: (group, symbol) => {
    if (!isGroupId(group)) return;
    set((state) => {
      const groupSymbols = { ...state.groupSymbols, [group]: symbol };
      persistFromState({ ...state, groupSymbols });
      return { groupSymbols };
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
}));
