/**
 * /study 창 워크스페이스 스토어 (ADR-0123 PR-2).
 *
 * /live 의 `workspace.ts` 와 같은 뼈대(창 배열 + zOrder + 단일 영속 깔때기)지만
 * 의도적으로 얇다:
 * - **그룹 없음** — 활성 저장뷰가 단일 암묵 그룹이다(종목은 탭이 SSOT).
 * - **차트 창 설정 없음** — timeframe 은 `studyTabs` 의 `tab.timeframe` 이 SSOT.
 *   v1 은 차트 창 1개 고정(ADR-0123 — 멀티 차트는 PR-4 판정, #801).
 * - **레거시 px 마이그레이션 없음** — 처음부터 비율 rect(ADR-0122)로 태어난다.
 *
 * 첫 하이드레이션은 `study.layout.v1`(카드 순서/숨김)에서 1회 시드해 기존 상세
 * 패널 구성을 창 배치로 옮긴다. `detailPanelCollapsed` 는 무시한다 — rail 접기는
 * "잠깐 치움"이지 숨김이 아니었으므로 창은 생성한다(플랜 §PR-2).
 */
import { create } from 'zustand';
import { isFracRect, toFrac, type FracRect } from '../workspace/rectSpace';
import type { Canvas } from '../workspace/snapEngine';
import { tidyLayout } from '../workspace/tidy';
import { persistJson, readJsonObject } from './persist';
import { STUDY_CARD_KEYS, STUDY_LAYOUT_STORAGE_KEY, type StudyCardKey } from './studyLayout';

export const STUDY_WORKSPACE_STORAGE_KEY = 'study.workspace.v1';
export const STUDY_WORKSPACE_SCHEMA_VERSION = 1;

export const STUDY_WINDOW_KINDS = ['chart', 'book', 'broker', 'vdist', 'program', 'memo'] as const;
export type StudyWindowKind = (typeof STUDY_WINDOW_KINDS)[number];

export interface StudyWorkspaceWindow {
  id: string;
  kind: StudyWindowKind;
  /** 캔버스 대비 비율 rect (ADR-0122). px 가 아니다. */
  rect: FracRect;
}

interface Persisted {
  windows: StudyWorkspaceWindow[];
  /** 마지막 = 최상단(포커스) 창. */
  zOrder: string[];
}

interface Store extends Persisted {
  /** 창 추가. `chart` 는 v1 단일 고정 — 이미 있으면 그 창을 포커스하고 id 반환. */
  addWindow: (kind: StudyWindowKind) => string;
  /** 창 닫기. 마지막 차트 창은 거부한다(차트 1개 불변식). */
  closeWindow: (id: string) => void;
  focusWindow: (id: string) => void;
  setWindowRect: (id: string, rect: FracRect) => void;
  setWindowRects: (updates: { id: string; rect: FracRect }[]) => void;
  tidyAll: (canvas: Canvas) => void;
  /** 스냅샷 통째 적용(왕복 대비 — 프리셋은 범위 밖). 유효 창 없으면 시드 폴백. */
  applySnapshot: (snapshot: unknown) => void;
}

let idCounter = 0;
function newWindowId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `sw_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;
}

function isStudyWindowKind(value: unknown): value is StudyWindowKind {
  return typeof value === 'string' && (STUDY_WINDOW_KINDS as readonly string[]).includes(value);
}

function readRect(raw: unknown): FracRect | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.x !== 'number' || typeof r.y !== 'number'
    || typeof r.w !== 'number' || typeof r.h !== 'number'
  ) return null;
  const rect = { x: r.x, y: r.y, w: r.w, h: r.h };
  return isFracRect(rect) ? rect : null;
}

function readWindow(raw: unknown): StudyWorkspaceWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as Record<string, unknown>;
  if (typeof w.id !== 'string' || !isStudyWindowKind(w.kind)) return null;
  const rect = readRect(w.rect);
  if (!rect) return null;
  return { id: w.id, kind: w.kind, rect };
}

/** zOrder 를 실제 창 id 집합에 맞춰 정규화(unknown 드롭, 누락 append). */
function normalizeZOrder(raw: unknown, windows: readonly StudyWorkspaceWindow[]): string[] {
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

/** 상세 패널 카드 → 창 kind (시드 전용 매핑). */
const CARD_TO_KIND: Record<StudyCardKey, StudyWindowKind> = {
  orderbook: 'book',
  brokers: 'broker',
  volumeDistribution: 'vdist',
  program: 'program',
};

/** 차트가 좌측에서 차지하는 가로 비율 — `tidy.ts` 의 CHART_FRACTION 과 같은 값. */
const SEED_CHART_FRACTION = 0.72;

/**
 * `study.layout.v1` 의 카드 순서/숨김에서 기본 창 배치를 만든다(순수 — 테스트 대상).
 * 차트 창 좌측 + 보이는 카드들을 우측 열에 순서대로 등분 스택. 숨긴 카드는 창을
 * 만들지 않는다(사용자가 치운 것). 메모는 시드에 없다 — 헤더 메모 버튼으로 연다.
 * zOrder 는 데이터 창들 뒤에 차트를 둬 첫 포커스가 차트가 되게 한다.
 */
export function buildStudyWorkspaceSeed(layout: {
  cardOrder: readonly StudyCardKey[];
  cardHidden: Partial<Record<StudyCardKey, boolean>>;
}): Persisted {
  const visible = layout.cardOrder.filter((key) => !layout.cardHidden[key]);
  const chartW = visible.length > 0 ? SEED_CHART_FRACTION : 1;
  const chart: StudyWorkspaceWindow = {
    id: newWindowId(),
    kind: 'chart',
    rect: { x: 0, y: 0, w: chartW, h: 1 },
  };
  const dataH = visible.length > 0 ? 1 / visible.length : 0;
  const dataWindows = visible.map((key, i): StudyWorkspaceWindow => ({
    id: newWindowId(),
    kind: CARD_TO_KIND[key],
    rect: { x: chartW, y: i * dataH, w: 1 - chartW, h: dataH },
  }));
  const windows = [chart, ...dataWindows];
  return { windows, zOrder: [...dataWindows.map((w) => w.id), chart.id] };
}

/** 시드 입력을 `study.layout.v1` 원시 값에서 관대하게 읽는다(스토어 미의존 —
 *  studyLayout 스토어의 하이드레이션 시점·테스트 격리에 결합하지 않기 위해). */
function readLegacyLayoutSeed(): Parameters<typeof buildStudyWorkspaceSeed>[0] {
  const parsed = readJsonObject(STUDY_LAYOUT_STORAGE_KEY);
  const rawOrder = Array.isArray(parsed.cardOrder) ? parsed.cardOrder : [];
  const seenOrder = rawOrder.filter((k): k is StudyCardKey =>
    (STUDY_CARD_KEYS as readonly string[]).includes(k as string));
  const cardOrder = [...seenOrder, ...STUDY_CARD_KEYS.filter((k) => !seenOrder.includes(k))];
  const cardHidden: Partial<Record<StudyCardKey, boolean>> = {};
  if (parsed.cardHidden && typeof parsed.cardHidden === 'object') {
    for (const [key, raw] of Object.entries(parsed.cardHidden as Record<string, unknown>)) {
      if ((STUDY_CARD_KEYS as readonly string[]).includes(key) && typeof raw === 'boolean') {
        cardHidden[key as StudyCardKey] = raw;
      }
    }
  }
  return { cardOrder, cardHidden };
}

/** 차트 1개 불변식 보정 — 손상 저장값에 차트가 없으면 좌측 기본 위치로 주입한다. */
function ensureChartWindow(persisted: Persisted): Persisted {
  if (persisted.windows.some((w) => w.kind === 'chart')) return persisted;
  const chart: StudyWorkspaceWindow = {
    id: newWindowId(),
    kind: 'chart',
    rect: { x: 0, y: 0, w: SEED_CHART_FRACTION, h: 1 },
  };
  return {
    windows: [chart, ...persisted.windows],
    zOrder: [...persisted.zOrder, chart.id],
  };
}

function persistFromState(state: Persisted): void {
  persistJson(STUDY_WORKSPACE_STORAGE_KEY, {
    schema_version: STUDY_WORKSPACE_SCHEMA_VERSION,
    windows: state.windows,
    zOrder: state.zOrder,
  });
}

/** raw 스냅샷 → canonical Persisted. 유효 창이 없으면 시드로 폴백(빈 워크스페이스로
 *  덮어써 창을 잃지 않게 — /live normalizeWorkspaceSnapshot 과 같은 규율). */
function normalizeSnapshot(raw: unknown): Persisted {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawWindows = Array.isArray(obj.windows) ? obj.windows : [];
  const windows = rawWindows
    .map(readWindow)
    .filter((w): w is StudyWorkspaceWindow => w !== null);
  if (windows.length === 0) return buildStudyWorkspaceSeed(readLegacyLayoutSeed());
  return ensureChartWindow({ windows, zOrder: normalizeZOrder(obj.zOrder, windows) });
}

/** 하이드레이션 — 저장값이 없거나 전부 무효면 `study.layout.v1` 에서 1회 시드하고
 *  즉시 persist 해 창 id 를 고정한다(재방문 시 재시드 없음). */
function readStorage(): Persisted {
  const parsed = readJsonObject(STUDY_WORKSPACE_STORAGE_KEY);
  const rawWindows = Array.isArray(parsed.windows) ? parsed.windows : [];
  const windows = rawWindows
    .map(readWindow)
    .filter((w): w is StudyWorkspaceWindow => w !== null);
  if (windows.length === 0) {
    const seed = buildStudyWorkspaceSeed(readLegacyLayoutSeed());
    persistFromState(seed);
    return seed;
  }
  return ensureChartWindow({ windows, zOrder: normalizeZOrder(parsed.zOrder, windows) });
}

/**
 * 새 창 기본 크기(px 실측 → REF 캔버스로 비율화, /live DEFAULT_SIZE 와 같은 방식).
 * book/broker/vdist/program 은 /live 의 실측값을 그대로 쓴다 — 같은 카드 컴포넌트를
 * 렌더하므로 "전부 보이는 높이"의 근거가 같다. memo 는 StudyMemoPanel 텍스트영역
 * 기준 소형 카드.
 */
const REF_CANVAS = { w: 1546, h: 776 };
const DEFAULT_SIZE: Record<StudyWindowKind, { w: number; h: number }> = {
  chart: { w: 520, h: 360 },
  book: { w: 680, h: 560 },
  broker: { w: 236, h: 280 },
  vdist: { w: 300, h: 240 },
  program: { w: 260, h: 200 },
  memo: { w: 320, h: 260 },
};

const hydrated = readStorage();

export const useStudyWorkspaceStore = create<Store>((set, get) => ({
  ...hydrated,

  addWindow: (kind) => {
    // 차트 1개 고정(v1) — 이미 있으면 새로 만들지 않고 포커스만 올린다.
    if (kind === 'chart') {
      const existing = get().windows.find((w) => w.kind === 'chart');
      if (existing) {
        get().focusWindow(existing.id);
        return existing.id;
      }
    }
    const id = newWindowId();
    set((state) => {
      const size = DEFAULT_SIZE[kind];
      const frac = { w: size.w / REF_CANVAS.w, h: size.h / REF_CANVAS.h };
      // 캐스케이드 오프셋 — 새 창이 서로 겹쳐 나지 않도록 창 수에 비례해 밀어낸다.
      const offPx = 24 + ((state.windows.length * 28) % 200);
      const win: StudyWorkspaceWindow = {
        id,
        kind,
        rect: {
          x: Math.min(offPx / REF_CANVAS.w, 1 - frac.w),
          y: Math.min(offPx / REF_CANVAS.h, 1 - frac.h),
          ...frac,
        },
      };
      const next = { windows: [...state.windows, win], zOrder: [...state.zOrder, id] };
      persistFromState({ ...state, ...next });
      return next;
    });
    return id;
  },

  closeWindow: (id) => {
    set((state) => {
      const target = state.windows.find((w) => w.id === id);
      if (!target) return {};
      // 차트 1개 불변식 — 마지막(=유일) 차트 창은 닫지 않는다.
      if (target.kind === 'chart') return {};
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
      if (!state.windows.some((w) => w.id === id)) return {};
      if (state.zOrder[state.zOrder.length - 1] === id) return {};
      const zOrder = [...state.zOrder.filter((i) => i !== id), id];
      persistFromState({ ...state, zOrder });
      return { zOrder };
    });
  },

  setWindowRect: (id, rect) => {
    get().setWindowRects([{ id, rect }]);
  },

  setWindowRects: (updates) => {
    set((state) => {
      const byId = new Map(updates.map((u) => [u.id, u.rect]));
      const windows = state.windows.map((w) => {
        const rect = byId.get(w.id);
        return rect && isFracRect(rect) ? { ...w, rect } : w;
      });
      persistFromState({ ...state, windows });
      return { windows };
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

  applySnapshot: (snapshot) => {
    const next = normalizeSnapshot(snapshot);
    set(() => {
      persistFromState(next);
      return next;
    });
  },
}));

/** 현재 워크스페이스 스냅샷(왕복 대비) — 스토어 내부 참조를 잡지 않도록 복제한다. */
export function snapshotStudyWorkspace(): Persisted {
  const s = useStudyWorkspaceStore.getState();
  return {
    windows: s.windows.map((w) => ({ ...w, rect: { ...w.rect } })),
    zOrder: [...s.zOrder],
  };
}
