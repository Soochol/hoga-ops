/**
 * /study 창 워크스페이스 스토어 (ADR-0123 PR-2).
 *
 * /live 의 `workspace.ts` 와 같은 뼈대(창 배열 + zOrder + 단일 영속 깔때기)지만
 * 의도적으로 얇다:
 * - **그룹 없음** — 활성 저장뷰가 단일 암묵 그룹이다(종목은 탭이 SSOT). 차트 창이
 *   여러 개여도 그대로다 — 창은 봉만 달리 볼 뿐 전부 같은 저장뷰를 본다.
 * - **레거시 px 마이그레이션 없음** — 처음부터 비율 rect(ADR-0122)로 태어난다.
 *
 * **차트 창은 여러 개 열 수 있다**(#801 판정: 도입, 2026-08-10). 같은 저장뷰를
 * 창마다 다른 봉으로 나란히 보기 위한 것이다 — 창별 저장뷰는 범위 밖이고 종목은
 * 여전히 탭이 SSOT 다. 남은 불변식은 **"차트 창이 0개가 되지 않는다"** 하나다
 * (`canCloseStudyWindow`).
 *
 * 차트 창은 `/live` 와 **같은 모양**의 `chart` 설정을 갖는다(#906) — 타입을
 * `ChartWindowConfig` 로 공유해 동형을 컴파일러가 강제한다. #907 이 `windowView`
 * 창-스코프 훅에 이 스토어를 핸들로 주입할 때, 훅이 어느 스토어인지 모른 채
 * `windows[].chart` 를 구독할 수 있어야 하기 때문이다(#901).
 *
 * 시드는 두 갈래다:
 * - **배치**는 `study.layout.v1`(카드 순서/숨김)에서 1회. `detailPanelCollapsed` 는
 *   무시한다 — rail 접기는 "잠깐 치움"이지 숨김이 아니었으므로 창은 생성한다(플랜 §PR-2).
 * - **차트 설정**은 `study.lastMinuteTimeframe.v1`(분봉)에서 1회. 지표는 시드하지
 *   않는다 — 창이 소유하지 않고 앱 전역 저장소(`live.indicators.v2`)에 있기
 *   때문이다. 그 저장소 안에서 `/study` 는 자기 세트를 갖지만(ADR-0146) 그것도
 *   페이지 축이지 창 축이 아니다.
 */
import { normalizeZOrder } from '../workspace/zOrder';
import { create } from 'zustand';
import { isFracRect, type FracRect } from '../workspace/rectSpace';
import { persistJson, readJsonObject } from './persist';
import { STUDY_WORKSPACE_STORAGE_KEY } from './workspaceKeys';
import { STUDY_CARD_KEYS, STUDY_LAYOUT_STORAGE_KEY, type StudyCardKey } from './studyLayout';
import {
  LIVE_TIMEFRAMES,
  MINUTE_TIMEFRAMES,
  type LiveTimeframe,
  type MinuteTimeframe,
} from './livePage';
import {
  STUDY_DEFAULT_MINUTE_TIMEFRAME,
  STUDY_LAST_MINUTE_TIMEFRAME_STORAGE_KEY,
} from './studyLastMinuteTimeframe';
// 창 설정 타입은 /live 와 **공유**한다(복제 금지) — 두 창 모양이 갈라지는 순간
// #907 의 스토어 핸들 주입이 성립하지 않는다.
import type { ChartWindowConfig, ChartWindowRuntime } from './workspace';
import { BOOK_WINDOW_DEFAULT_W } from '../live/workspace/bookPanelMetrics';

export { STUDY_WORKSPACE_STORAGE_KEY };
export const STUDY_WORKSPACE_SCHEMA_VERSION = 1;

export const STUDY_WINDOW_KINDS = ['chart', 'book', 'broker', 'vdist', 'program', 'memo'] as const;
export type StudyWindowKind = (typeof STUDY_WINDOW_KINDS)[number];

export interface StudyWorkspaceWindow {
  id: string;
  kind: StudyWindowKind;
  /** 캔버스 대비 비율 rect (ADR-0122). px 가 아니다. */
  rect: FracRect;
  /** kind==='chart' 에서만 존재. 타입은 `/live` 와 공유(#906). */
  chart?: ChartWindowConfig;
}

interface Persisted {
  windows: StudyWorkspaceWindow[];
  /** 마지막 = 최상단(포커스) 창. */
  zOrder: string[];
}

interface Store extends Persisted {
  /** 창별 비영속 런타임(#713 뷰포트 비저장과 정합) — 좌측 팬 딥 백필의 from-date. */
  chartRuntime: Record<string, ChartWindowRuntime>;

  /** 창 추가. `chart` 는 포커스된 차트의 설정을 복제해 새로 만든다(#801). */
  addWindow: (kind: StudyWindowKind) => string;
  /** 창 닫기. **마지막** 차트 창만 거부한다(`canCloseStudyWindow`). */
  closeWindow: (id: string) => void;
  focusWindow: (id: string) => void;
  setWindowRect: (id: string, rect: FracRect) => void;
  setWindowRects: (updates: { id: string; rect: FracRect }[]) => void;
  /** 스냅샷 통째 적용(왕복 대비 — 프리셋은 범위 밖). 유효 창 없으면 시드 폴백. */
  applySnapshot: (snapshot: unknown) => void;

  // ── 차트 창 설정 쓰기 경로 ────────────────────────────────────────────────
  // `/live` workspace 스토어와 **같은 이름·같은 시그니처**다. #907 이 windowView 의
  // `useHistoricalRangeActions` 에 이 스토어를 핸들로 주입하면 그쪽 코드가 어느
  // 스토어인지 모른 채 호출한다(#901). 지표 액션은 양쪽 모두에서 사라졌다 —
  // 설정이 전역으로 돌아가면서 창이 소유하는 것은 봉과 백필뿐이다.
  setChartTimeframe: (id: string, tf: LiveTimeframe) => void;
  extendChartHistoricalRange: (id: string, date: string) => void;
  resetChartHistoricalRange: (id: string) => void;
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

function isLiveTimeframe(value: unknown): value is LiveTimeframe {
  return typeof value === 'string' && (LIVE_TIMEFRAMES as readonly string[]).includes(value);
}

/** `livePage.isMinuteTimeframe` 은 인자를 `LiveTimeframe` 으로 좁혀 받아 raw 검증에
 *  못 쓴다 — `/live` workspace 의 `isMinuteFrameValue` 와 같은 unknown 판별자. */
function isMinuteFrameValue(value: unknown): value is MinuteTimeframe {
  return typeof value === 'string' && (MINUTE_TIMEFRAMES as readonly string[]).includes(value);
}

/**
 * 저장된 `chart` 설정을 관대하게 읽는다(`/live` readWindow 미러) — 필드 부재는
 * 버림이 아니라 기본값 채움이다. 스키마 버전을 올리지 않는 이유가 여기 있다(#904):
 * 필드 추가는 관대 파싱으로 흡수되고, 버전 검사를 넣는 순간 "불일치 시 무엇을
 * 버릴지"를 정해야 하는데 그게 과잉 무효화의 입구다(#577).
 */
function readChartConfig(raw: Record<string, unknown>): ChartWindowConfig {
  // 구 스냅샷의 `raw.indicators` 는 읽지 않는다 — 전역으로 1회 승격된 뒤
  // (`indicatorsWindowMigration`) 다음 저장 때 자연 소멸한다.
  const chart: ChartWindowConfig = {
    timeframe: isLiveTimeframe(raw.timeframe) ? raw.timeframe : STUDY_DEFAULT_MINUTE_TIMEFRAME,
  };
  if (isMinuteFrameValue(raw.lastMinuteTimeframe)) {
    chart.lastMinuteTimeframe = raw.lastMinuteTimeframe;
  } else if (isMinuteFrameValue(chart.timeframe)) {
    // 저장값이 없거나 무효면 현재 분봉에서 파생(`/live` 하이드레이션 미러) —
    // 분봉 슬롯 복귀가 기본값으로 퇴행하지 않게.
    chart.lastMinuteTimeframe = chart.timeframe;
  }
  return chart;
}

function readWindow(raw: unknown): StudyWorkspaceWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as Record<string, unknown>;
  if (typeof w.id !== 'string' || !isStudyWindowKind(w.kind)) return null;
  const rect = readRect(w.rect);
  if (!rect) return null;
  const win: StudyWorkspaceWindow = { id: w.id, kind: w.kind, rect };
  // 설정이 없는 차트 창은 여기서 채우지 않는다 — 시드는 ensureChartWindow 가
  // 한 곳에서 맡아 "시드가 붙었는가"를 호출부가 알 수 있게 한다.
  if (w.kind === 'chart' && w.chart && typeof w.chart === 'object') {
    win.chart = readChartConfig(w.chart as Record<string, unknown>);
  }
  return win;
}


/** 상세 패널 카드 → 창 kind (시드 전용 매핑). */
const CARD_TO_KIND: Record<StudyCardKey, StudyWindowKind> = {
  orderbook: 'book',
  brokers: 'broker',
  volumeDistribution: 'vdist',
  program: 'program',
};

/** 차트가 좌측에서 차지하는 가로 비율(시드 배치). */
const SEED_CHART_FRACTION = 0.72;
/**
 * 10호가(십자 배치 BookPanel)가 보일 때의 차트 비율.
 *
 * BookPanel 의 폭 계약(`bookPanelMetrics`)은 절대 px 인데 /study 캔버스는 탭 바+헤더를
 * 뺀 나머지라 /live 보다 작다(실측 1280 뷰포트에서 1190×531 vs /live REF 1546×776).
 * 그래서 비율은 **좁은 쪽(1190)에서 역산**한다 — 우측 열 = (1 − 0.58) × 1190 = 500px
 * 로 `BOOK_WINDOW_DEFAULT_W`(480) 를 20px 넘긴다.
 *
 * 2026-08-16 에 하한이 560→448 로 내려오며 0.50 → 0.58 로 넓혔다(차트 595 → 690px).
 * 상한은 0.5966 (= 1 − 480/1190) 이고 그 위로 올리면 첫 시드부터 가로 스크롤이다.
 */
const SEED_CHART_FRACTION_WITH_BOOK = 0.58;
/**
 * 10호가의 세로 가중치. 전 10단을 다 보려면 ~462px 가 필요한데(행 22px × 21),
 * 그건 /study 캔버스 높이(531px)의 87% 라 다른 창과 함께 담을 수 없다. 가장
 * 많이 주되(가중 3 = 절반) 나머지 카드가 죽지 않는 선에서 타협하고, 전 단을 볼
 * 때는 사용자가 창을 키우는 것을 전제한다. 넓은 모니터에서는 자연히 해소된다.
 */
const SEED_BOOK_HEIGHT_WEIGHT = 3;

/**
 * `study.layout.v1` 의 카드 순서/숨김에서 기본 창 배치를 만든다(순수 — 테스트 대상).
 * 차트 창 좌측 + 보이는 카드들을 우측 열에 순서대로 스택. 10호가는 십자 배치라
 * 다른 카드의 두 배 높이 가중치를 받고, 보이면 우측 열 자체도 넓어진다. 숨긴
 * 카드는 창을 만들지 않는다(사용자가 치운 것). 메모는 시드에 없다 — 헤더 메모
 * 버튼으로 연다. zOrder 는 데이터 창들 뒤에 차트를 둬 첫 포커스가 차트가 되게 한다.
 */
export function buildStudyWorkspaceSeed(layout: {
  cardOrder: readonly StudyCardKey[];
  cardHidden: Partial<Record<StudyCardKey, boolean>>;
}): Persisted {
  const visible = layout.cardOrder.filter((key) => !layout.cardHidden[key]);
  const hasBook = visible.includes('orderbook');
  const chartW = visible.length === 0
    ? 1
    : hasBook
      ? SEED_CHART_FRACTION_WITH_BOOK
      : SEED_CHART_FRACTION;
  const chart: StudyWorkspaceWindow = {
    id: newWindowId(),
    kind: 'chart',
    rect: { x: 0, y: 0, w: chartW, h: 1 },
    chart: seedChartConfig(),
  };
  const weightOf = (key: StudyCardKey) => (key === 'orderbook' ? SEED_BOOK_HEIGHT_WEIGHT : 1);
  const totalWeight = visible.reduce((acc, key) => acc + weightOf(key), 0);
  let y = 0;
  const dataWindows = visible.map((key): StudyWorkspaceWindow => {
    const h = weightOf(key) / totalWeight;
    const win: StudyWorkspaceWindow = {
      id: newWindowId(),
      kind: CARD_TO_KIND[key],
      rect: { x: chartW, y, w: 1 - chartW, h },
    };
    y += h;
    return win;
  });
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

/**
 * 차트 창 설정 시드 입력을 전역 키에서 관대하게 읽는다(#904).
 *
 * `readLegacyLayoutSeed` 와 같은 규율으로 **스토어를 경유하지 않는다** —
 * `livePage`·`studyLastMinuteTimeframe` 스토어의 하이드레이션 시점·테스트 격리에
 * 결합하지 않기 위해서다. 모듈 로드 시 1회만 읽는다.
 *
 * 지표는 더 이상 시드하지 않는다 — 창이 소유하지 않으므로 시드할 것이 없다.
 */
function readLegacyChartConfigSeed(): ChartWindowConfig {
  const minuteRaw = readJsonObject(STUDY_LAST_MINUTE_TIMEFRAME_STORAGE_KEY).lastMinuteTimeframe;
  const lastMinute: MinuteTimeframe = isMinuteFrameValue(minuteRaw)
    ? minuteRaw
    : STUDY_DEFAULT_MINUTE_TIMEFRAME;
  return {
    // 봉은 #902 로 "창이 소유하되 탭이 시드" 다. 탭은 이 스토어 밖이라 여기서는
    // 알 수 없으므로, 탭이 시드하기 전까지 쓸 값으로 `/study` 의 마지막 분봉을
    // 놓는다('1m' 은 `/study` 가 쓰지 않는 값이라 폴백으로 부적절).
    timeframe: lastMinute,
    lastMinuteTimeframe: lastMinute,
  };
}

let chartConfigSeed: ChartWindowConfig | null = null;
/** 시드는 값이지 상태다 — 창마다 같은 참조를 나눠 갖지 않도록 매번 복제해 준다. */
function seedChartConfig(): ChartWindowConfig {
  chartConfigSeed ??= readLegacyChartConfigSeed();
  return { ...chartConfigSeed };
}

/**
 * 이 창을 닫아도 되는가 — **"차트 창이 0개가 되지 않는다"** 가 유일한 불변식이다
 * (#801).
 *
 * 세 곳이 같은 답을 내야 한다: 스토어의 `closeWindow` 거부, 창 프레임의 닫기
 * 어포던스, 창 목록 메뉴. 술어를 복제하면 "버튼은 있는데 안 닫힌다"(또는 그 반대)가
 * 생기므로 여기 하나만 둔다.
 */
export function canCloseStudyWindow(
  windows: readonly StudyWorkspaceWindow[],
  id: string,
): boolean {
  const target = windows.find((w) => w.id === id);
  if (!target) return false;
  if (target.kind !== 'chart') return true;
  return windows.filter((w) => w.kind === 'chart').length > 1;
}

/**
 * 포커스된 차트 창 = zOrder 최상단의 차트 창.
 *
 * 창이 여러 개일 때 **탭 라벨 write-through·커서 해석·뷰포트 캡처**가 이 창을
 * 따른다(#801 단계 1). 창이 하나면 그 창이므로 기존 동작과 같다.
 */
export function focusedChartWindowId(state: {
  windows: readonly StudyWorkspaceWindow[];
  zOrder: readonly string[];
}): string | null {
  for (let i = state.zOrder.length - 1; i >= 0; i -= 1) {
    const id = state.zOrder[i];
    if (state.windows.some((w) => w.id === id && w.kind === 'chart')) return id;
  }
  return state.windows.find((w) => w.kind === 'chart')?.id ?? null;
}

/** 차트 창에 설정이 빠진 게 있는가(하이드레이션 시 시드 여부 판정용). */
function needsChartConfigSeed(windows: readonly StudyWorkspaceWindow[]): boolean {
  return windows.some((w) => w.kind === 'chart' && !w.chart);
}

/**
 * 차트 0개 금지 + 설정 보정 — 손상 저장값에 차트가 없으면 좌측 기본 위치로
 * 주입하고, 설정이 없는 **모든** 차트 창에 시드 설정을 붙인다(#906).
 *
 * **배치는 절대 건드리지 않는다** — 설정 신설이 rect·zOrder 를 초기화하면 그게
 * 과잉 무효화다(#577).
 */
function ensureChartWindow(persisted: Persisted): Persisted {
  const windows = persisted.windows.map((w) =>
    w.kind === 'chart' && !w.chart ? { ...w, chart: seedChartConfig() } : w);
  if (windows.some((w) => w.kind === 'chart')) return { ...persisted, windows };
  const chart: StudyWorkspaceWindow = {
    id: newWindowId(),
    kind: 'chart',
    rect: { x: 0, y: 0, w: SEED_CHART_FRACTION, h: 1 },
    chart: seedChartConfig(),
  };
  return {
    windows: [chart, ...windows],
    zOrder: [...persisted.zOrder, chart.id],
  };
}

/**
 * 모든 setter 가 지나는 단일 영속화 지점.
 *
 * authoritative 는 **자기 탭의 sessionStorage** — 다른 탭을 절대 덮어쓰지 않는다.
 * 이 함수는 바뀐 필드가 아니라 그 탭의 인메모리 스냅샷 전체를 쓰므로(호출부 전부가
 * `{...state, 바뀐것}` 패턴), 두 탭이 같은 localStorage 키를 공유하면 오래된 탭의
 * 조작 하나가 다른 탭의 창 배치를 통째로 되돌린다. 두 탭 화면은 각자 자기 메모리를
 * 계속 그리므로 **조용히** 깨지고 손실은 다음 새로고침에야 드러난다(/live 와 동일
 * 기전 — `state/workspace.ts` 스코프 주석).
 *
 * 공유 키(localStorage)는 **새 탭의 시드 전용**이다. 이미 열린 탭은 하이드레이션
 * 이후 두 번 다시 읽지 않으므로 누가 마지막에 썼든 무해하다.
 *
 * **`/live` 와 다른 점**: 저기선 딥링크 탭(`?code=`)만 시드 갱신에서 뺐지만 여기선
 * 예외가 없다 — `/study?view=` 는 활성 탭에 맞춰 URL 이 항상 재작성되므로
 * (StudyPage 의 `navigate('/study?view=…', {replace:true})`) "쿼리가 있다 = 곁눈질
 * 탭" 이 성립하지 않는다. 그 휴리스틱을 옮기면 모든 탭이 딥링크로 분류돼 시드가
 * 영영 갱신되지 않고, 새 탭은 언제까지나 최초 시드 배치로만 열린다.
 */
function persistFromState(state: Persisted): void {
  const snapshot = {
    schema_version: STUDY_WORKSPACE_SCHEMA_VERSION,
    windows: state.windows,
    zOrder: state.zOrder,
  };
  persistJson(STUDY_WORKSPACE_STORAGE_KEY, snapshot, 'tab');
  persistJson(STUDY_WORKSPACE_STORAGE_KEY, snapshot, 'shared');
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

/** raw 스냅샷 — 자기 탭 저장소가 authoritative. 비어 있으면(새 탭) 공유 시드를
 *  **읽기만 해서** 물려받는다: 늘 쓰던 배치 그대로 열리되 이후 변경은 그 탭에서
 *  시작한다. 시드는 이 시점에 쓰지 않는다(열기만 해서는 아무것도 안 바뀐다). */
function readStudyWorkspaceSnapshot(): Record<string, unknown> {
  const own = readJsonObject(STUDY_WORKSPACE_STORAGE_KEY, 'tab');
  if (Array.isArray(own.windows)) return own;
  return readJsonObject(STUDY_WORKSPACE_STORAGE_KEY, 'shared');
}

/**
 * 하이드레이션 — 저장값이 없거나 전부 무효면 `study.layout.v1` 에서 1회 시드하고
 * 즉시 persist 해 창 id 를 고정한다(재방문 시 재시드 없음).
 *
 * 차트 설정 시드는 **이 빈-시드 경로만으로 부족하다**: 기존 사용자는 이미
 * `study.workspace.v1` 에 창을 갖고 있어 여기로 오지 않는다. 설정이 없는 차트
 * 창에 시드가 붙는 경로는 `ensureChartWindow` 고, 붙었으면 즉시 고정한다 —
 * 안 그러면 매 방문마다 전역 키를 다시 읽어 사용자가 창에서 바꾼 값이 덮인다.
 */
function readStorage(): Persisted {
  const parsed = readStudyWorkspaceSnapshot();
  const rawWindows = Array.isArray(parsed.windows) ? parsed.windows : [];
  const windows = rawWindows
    .map(readWindow)
    .filter((w): w is StudyWorkspaceWindow => w !== null);
  if (windows.length === 0) {
    const seed = buildStudyWorkspaceSeed(readLegacyLayoutSeed());
    persistFromState(seed);
    return seed;
  }
  const seeded = needsChartConfigSeed(windows) || !windows.some((w) => w.kind === 'chart');
  const next = ensureChartWindow({ windows, zOrder: normalizeZOrder(parsed.zOrder, windows) });
  if (seeded) persistFromState(next);
  return next;
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
  // book 폭은 `bookPanelMetrics` 가 SSOT (= min-w + 스크롤바·여유). 높이 560 은
  // 행 수(22×22 + 총잔량바)가 정하므로 폭 축소와 무관하게 불변이다.
  // live/state/workspace.ts 의 book 정의와 같은 상수를 본다.
  book: { w: BOOK_WINDOW_DEFAULT_W, h: 560 },
  broker: { w: 236, h: 280 },
  vdist: { w: 300, h: 240 },
  program: { w: 260, h: 200 },
  memo: { w: 320, h: 260 },
};

const EMPTY_RUNTIME: ChartWindowRuntime = {
  historicalFromDate: null,
  lastMinuteHistoricalFromDate: null,
};

/** 차트 창 설정 변경 공통 경로 — 대상이 차트 창일 때만 fn 으로 chart 를 교체한다.
 *  창을 못 찾거나 차트 창이 아니면 null → 호출부가 no-op 한다(`/live` 미러). */
function withChart(
  state: Pick<Persisted, 'windows'>,
  id: string,
  fn: (chart: ChartWindowConfig) => ChartWindowConfig,
): StudyWorkspaceWindow[] | null {
  const win = state.windows.find((w) => w.id === id);
  if (!win?.chart) return null;
  const chart = fn(win.chart);
  return state.windows.map((w) => (w.id === id ? { ...w, chart } : w));
}

const hydrated = readStorage();

export const useStudyWorkspaceStore = create<Store>((set, get) => ({
  ...hydrated,
  chartRuntime: {},

  addWindow: (kind) => {
    // 새 차트 창은 **포커스된 차트의 봉을 복제**해서 난다(#801). 기본값으로
    // 태어나면 "복제 후 한쪽만 일봉으로" 라는 실제 사용 흐름에서 매번 봉을 다시
    // 맞춰야 한다.
    const chartSeed = kind === 'chart'
      ? (() => {
          const s = get();
          const focused = s.windows.find((w) => w.id === focusedChartWindowId(s))?.chart;
          return focused ? { ...focused } : seedChartConfig();
        })()
      : undefined;
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
        ...(chartSeed ? { chart: chartSeed } : {}),
      };
      const next = { windows: [...state.windows, win], zOrder: [...state.zOrder, id] };
      persistFromState({ ...state, ...next });
      return next;
    });
    return id;
  },

  closeWindow: (id) => {
    set((state) => {
      // 남은 불변식은 "차트 창 0개 금지" 뿐이다 — 술어는 한 곳(#801).
      if (!canCloseStudyWindow(state.windows, id)) return {};
      const next = {
        windows: state.windows.filter((w) => w.id !== id),
        zOrder: state.zOrder.filter((i) => i !== id),
      };
      persistFromState({ ...state, ...next });
      if (!(id in state.chartRuntime)) return next;
      const chartRuntime = { ...state.chartRuntime };
      delete chartRuntime[id];
      return { ...next, chartRuntime };
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

  applySnapshot: (snapshot) => {
    const next = normalizeSnapshot(snapshot);
    set(() => {
      persistFromState(next);
      // 창 전면 교체 → 비영속 런타임을 걷는다(fresh-view, `/live` 미러).
      return { ...next, chartRuntime: {} };
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
        ...(isMinuteFrameValue(tf) ? { lastMinuteTimeframe: tf } : {}),
      }));
      if (!windows) return {};
      // 분봉을 떠나는 순간의 pan 창 기억 + 백필 리셋(`/live` setChartTimeframe 미러).
      const rt = state.chartRuntime[id] ?? EMPTY_RUNTIME;
      const chartRuntime = {
        ...state.chartRuntime,
        [id]: {
          historicalFromDate: null,
          lastMinuteHistoricalFromDate: isMinuteFrameValue(prev.timeframe)
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
    set({ chartRuntime: { ...state.chartRuntime, [id]: { ...rt, historicalFromDate: date } } });
  },

  resetChartHistoricalRange: (id) => {
    set((state) => {
      if (!(id in state.chartRuntime)) return {};
      const chartRuntime = { ...state.chartRuntime };
      delete chartRuntime[id];
      return { chartRuntime };
    });
  },
}));

/** 현재 워크스페이스 스냅샷(왕복 대비) — 스토어 내부 참조를 잡지 않도록 복제한다.
 *  chart 설정도 값까지 새 객체로(`/live` snapshotWorkspace 와 같은 근거). */
export function snapshotStudyWorkspace(): Persisted {
  const s = useStudyWorkspaceStore.getState();
  return {
    windows: s.windows.map((w) => ({
      ...w,
      rect: { ...w.rect },
      ...(w.chart ? { chart: { ...w.chart } } : {}),
    })),
    zOrder: [...s.zOrder],
  };
}
