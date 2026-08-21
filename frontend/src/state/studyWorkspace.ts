/**
 * /study 창 워크스페이스 스토어 (ADR-0123 PR-2 · ADR-0154).
 *
 * /live 의 `workspace.ts` 와 **같은 뼈대**다: 창 배열 + zOrder + 링크 그룹 + 단일
 * 영속 깔때기. 두 페이지가 갈리는 지점은 그룹이 **무엇을 가리키느냐** 하나다:
 * - `/live` — 그룹 → 종목 (`groupSymbols`, #711)
 * - `/study` — 그룹 → **저장뷰** (`groupViews`, ADR-0154)
 *
 * 종목이 아니라 저장뷰인 이유: 복기 쿼리는 종목만으로 서지 않는다. 어느 날 · 어느
 * 구간까지가 쿼리 키이고, 저장뷰가 그 셋을 한 덩어리로 들고 있다.
 *
 * 번호 자체(범위 1..10 · 판별자)는 페이지 중립 leaf `workspace/groupId` 가 소유한다 —
 * `/live` 스토어를 런타임 import 하면 `/study` 를 여는 것만으로 저쪽이 하이드레이션돼
 * `live.workspace.v1` 에 시드를 쓴다(그 파일 주석).
 *
 * 여전히 갈리는 것: **레거시 px 마이그레이션 없음** — 처음부터 비율 rect(ADR-0122)로
 * 태어난다.
 *
 * **차트 창은 여러 개 열 수 있다**(#801 판정: 도입, 2026-08-10). 원래 근거는 같은
 * 저장뷰를 창마다 다른 봉으로 나란히 보는 것이었고, ADR-0154 로 **창마다 다른
 * 저장뷰**도 된다. 남은 불변식은 **"차트 창이 0개가 되지 않는다"** 하나다
 * (`canCloseStudyWindow`).
 *
 * 차트 창은 `/live` 와 **같은 모양**의 `chart` 설정을 갖는다(#906) — 타입을
 * `ChartWindowConfig` 로 공유해 동형을 컴파일러가 강제한다. #907 이 `windowView`
 * 창-스코프 훅에 이 스토어를 핸들로 주입할 때, 훅이 어느 스토어인지 모른 채
 * `windows[].chart` 를 구독할 수 있어야 하기 때문이다(#901).
 *
 * 시드는 세 갈래다:
 * - **배치**는 `study.layout.v1`(카드 순서/숨김)에서 1회. `detailPanelCollapsed` 는
 *   무시한다 — rail 접기는 "잠깐 치움"이지 숨김이 아니었으므로 창은 생성한다(플랜 §PR-2).
 * - **그룹 1 의 저장뷰**는 `study.activeView.v1` 에서 1회. 그 키가 다시 `study.tabs.v1`
 *   을 승계했으므로 사슬은 두 홉이다(ADR-0149). 근거는 `readLegacyGroupViewSeed`.
 * - **차트 설정**은 `study.lastMinuteTimeframe.v1`(분봉)에서 1회. 지표는 시드하지
 *   않는다 — 창이 소유하지 않고 앱 전역 저장소(`live.indicators.v2`)에 있기
 *   때문이다. 그 저장소 안에서 `/study` 는 자기 페이지 세트를 갖고(ADR-0146) 창은
 *   자기 세트를 갖지만(ADR-0152), 창이 **소유**하는 것은 스코프 키뿐이라 스냅샷에
 *   지표가 실리지 않는 것은 그대로다.
 */
import { REFERENCE_CANVAS as REF_CANVAS } from '../workspace/referenceCanvas';
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
// 그룹 번호는 페이지 중립 leaf 에서 온다 — `state/workspace.ts`(=/live 스토어)를
// 런타임으로 끌어오지 않기 위해서다(위 스코프 주석).
import { MIN_GROUP, isGroupId, type GroupId } from '../workspace/groupId';
import { BOOK_WINDOW_DEFAULT_W } from '../live/workspace/bookPanelMetrics';
import {
  dropIndicatorScopesForRemovedWindows,
  dropIndicatorScopesForWindows,
  seedIndicatorScopeForWindow,
} from './indicatorScopeGc';

export { STUDY_WORKSPACE_STORAGE_KEY };
export const STUDY_WORKSPACE_SCHEMA_VERSION = 1;

export const STUDY_WINDOW_KINDS = ['chart', 'book', 'broker', 'vdist', 'program', 'memo'] as const;
export type StudyWindowKind = (typeof STUDY_WINDOW_KINDS)[number];

/** 소비자가 `/live` 짝처럼 스토어 모듈에서 가져갈 수 있게 재수출한다. */
export type { GroupId };

/**
 * 그룹이 가리키는 저장뷰 — `/live` `GroupSymbol` 의 `/study` 짝(ADR-0154).
 *
 * 네 필드는 ADR-0149 가 `study.activeView.v1` 에 정한 것 그대로 승계한다.
 *
 * - **`code` 는 필수다.** `studyWindowWorkspace.getWorkareaCode()` 가 `getState()` 로
 *   동기 fresh 읽기를 하고, 새로고침 직후 저장뷰 목록 쿼리가 뜨기 전에도 "이 창의
 *   종목이 뭐냐" 에 답해야 한다. 못 답하면 `useWindowViewGuard` 를 타는 디바운스/타이머
 *   콜백이 조용히 버려진다. 이 맵을 **영속**하는 이유가 이것이다.
 * - **`label`/`name` 은 가공 없는 raw** 다 — saves 도착 전 한 프레임의 헤더·탭 제목
 *   폴백. 드로어 rename 뒤에는 stale 이지만, 소비자가 서버 값을 앞에 두므로
 *   (`studyDocumentTitle`) 화면에는 곧바로 반영된다.
 * - **`timeframe` 은 담지 않는다.** 봉의 소유자는 차트 창이다(#1326) — 여기 두면 두
 *   번째 진실이 생겨 #902↔#1326 왕복이 재발한다. 그룹이 생겨도 그대로다: 한 그룹에
 *   봉이 다른 차트 창 둘을 두는 것이 이 페이지의 원래 용도다(#801).
 * - **`viewport` 도 담지 않는다.** ADR-0149 §4 의 판정이 그룹 축에서도 성립한다 —
 *   그룹은 상시 공존이라 "이탈 시 캡처 → 복귀 시 복원" 이라는 사건 자체가 없다.
 */
export interface StudyGroupView {
  viewId: string;
  code: string;
  label: string;
  name: string;
}

/**
 * 저장뷰 목록 행 → 그룹 저장뷰 (ADR-0149 `studyActiveViewFromSave` 승계).
 *
 * 필드명이 갈리는 자리는 `id` → `viewId` 하나뿐이고, 손 매핑이 두 곳으로 흩어지면
 * 한쪽만 고쳐지는 종류의 드리프트가 난다. 인자를 구조형으로 받아 이 스토어가
 * `api/studyViews` 를 import 하지 않게 한다.
 */
export function studyGroupViewFromSave(
  save: { id: string; code: string; label: string; name: string },
): StudyGroupView {
  return { viewId: save.id, code: save.code, label: save.label, name: save.name };
}

export interface StudyWorkspaceWindow {
  id: string;
  kind: StudyWindowKind;
  /** 링크 그룹 = **저장뷰** SSOT (ADR-0154). 창은 저장뷰를 직접 들지 않는다. */
  group: GroupId;
  /** 캔버스 대비 비율 rect (ADR-0122). px 가 아니다. */
  rect: FracRect;
  /** kind==='chart' 에서만 존재. 타입은 `/live` 와 공유(#906). */
  chart?: ChartWindowConfig;
}

/**
 * 프리셋·왕복이 담는 것 = **배치뿐**. `groupViews` 가 빠진 것이 이 타입의 요점이다
 * (`/live` `WorkspaceSnapshot` 과 같은 규율).
 *
 * 프리셋은 "어떻게 배치할까" 이지 "무엇을 볼까" 가 아니다. 그룹 **번호**는 배치의
 * 일부라 남지만 그 번호가 어느 저장뷰인지는 프리셋 밖의 현재 상태가 정한다 — 안
 * 그러면 배치를 불러오는 것만으로 보던 복기뷰가 통째로 바뀐다.
 *
 * 타입으로 막는 것이 핵심이다: `StudyLayoutPresetPayload` 는 `{windows, zOrder}` 라
 * `Persisted` 의 **구조적 부분집합**이고, 변수 대입에는 excess property check 가 걸리지
 * 않는다 — 즉 `Persisted` 를 그대로 넘기면 `groupViews` 가 조용히 프리셋에 실린다.
 */
export type StudyWorkspaceSnapshot = {
  windows: StudyWorkspaceWindow[];
  /** 마지막 = 최상단(포커스) 창. */
  zOrder: string[];
};

interface Persisted extends StudyWorkspaceSnapshot {
  /** 그룹 → 저장뷰. 창이 아니라 **그룹**이 들므로 창을 닫아도 뷰는 남는다. */
  groupViews: Partial<Record<GroupId, StudyGroupView>>;
}

interface Store extends Persisted {
  /** 창별 비영속 런타임(#713 뷰포트 비저장과 정합) — 좌측 팬 딥 백필의 from-date. */
  chartRuntime: Record<string, ChartWindowRuntime>;

  /** 창 추가. 새 창은 **활성 그룹을 상속**하고(#711 미러), `chart` 는 포커스된
   *  차트의 설정을 복제해 새로 만든다(#801). */
  addWindow: (kind: StudyWindowKind) => string;
  /** 창 닫기. **마지막** 차트 창만 거부한다(`canCloseStudyWindow`). */
  closeWindow: (id: string) => void;
  focusWindow: (id: string) => void;
  setWindowRect: (id: string, rect: FracRect) => void;
  setWindowRects: (updates: { id: string; rect: FracRect }[]) => void;
  /** 스냅샷 통째 적용(왕복 대비 — 프리셋은 범위 밖). 유효 창 없으면 시드 폴백.
   *  **`groupViews` 는 payload 에서 읽지 않는다** — 배치만 교체한다. */
  applySnapshot: (snapshot: unknown) => void;

  // ── 링크 그룹 (ADR-0154) ─────────────────────────────────────────────────
  /** 창을 다른 그룹으로 옮긴다 = 이 창의 표시 저장뷰 교체. */
  setWindowGroup: (id: string, group: GroupId) => void;
  /** 그룹이 볼 저장뷰를 정한다 — 그 그룹 창들이 **함께** 갈아탄다(SSOT). */
  setGroupView: (group: GroupId, view: StudyGroupView) => void;
  /** 저장뷰가 삭제됐을 때: 그 뷰를 보던 **모든** 그룹을 비우고, 비웠는지 답한다.
   *  ADR-0149 `clearIfView` 의 그룹 판 — "다음 뷰" 를 고르지 않는 것도 그대로다
   *  (사용자가 지운 직후 뜻밖의 다른 뷰가 뜨는 것보다 빈 상태가 낫다). */
  clearGroupsOfView: (viewId: string) => boolean;

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
  // 그룹은 **관대 파싱**이다(#904 규율) — 없거나 무효면 1. 스키마 버전을 올리지 않는
  // 이유가 여기 있다: 필드 추가는 이 폴백이 흡수하고, 버전 검사를 넣는 순간 "불일치 시
  // 무엇을 버릴지" 를 정해야 하는데 그게 과잉 무효화의 입구다(#577). 기존 저장분의
  // 창이 전부 그룹 1 로 읽히는 것이 승계가 그룹 1 을 고르는 이유이기도 하다.
  const win: StudyWorkspaceWindow = {
    id: w.id,
    kind: w.kind,
    group: isGroupId(w.group) ? w.group : MIN_GROUP,
    rect,
  };
  // 설정이 없는 차트 창은 여기서 채우지 않는다 — 시드는 ensureChartWindow 가
  // 한 곳에서 맡아 "시드가 붙었는가"를 호출부가 알 수 있게 한다.
  if (w.kind === 'chart' && w.chart && typeof w.chart === 'object') {
    win.chart = readChartConfig(w.chart as Record<string, unknown>);
  }
  return win;
}

/** 저장뷰 한 벌의 관대 파싱. 판정은 `viewId`·`code` 두 문자열뿐이고 나머지는 빈
 *  문자열로 채운다 — ADR-0149 의 `isStudyActiveView` 와 **같은 강도**로 둔다(이 함수가
 *  옛 키 승계 경로에서도 쓰이므로, 강도를 올리면 승계가 조용히 줄어든다). */
function readGroupView(raw: unknown): StudyGroupView | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.viewId !== 'string' || typeof v.code !== 'string') return null;
  return {
    viewId: v.viewId,
    code: v.code,
    label: typeof v.label === 'string' ? v.label : '',
    name: typeof v.name === 'string' ? v.name : '',
  };
}

/** 그룹 → 저장뷰 맵의 관대 파싱(`/live` `readGroupSymbols` 미러). 키가 그룹 번호가
 *  아니거나 값이 저장뷰 모양이 아니면 그 항목만 버린다. */
function readGroupViews(raw: unknown): Partial<Record<GroupId, StudyGroupView>> {
  const out: Partial<Record<GroupId, StudyGroupView>> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const group = Number(key);
    if (!isGroupId(group)) continue;
    const view = readGroupView(val);
    if (view) out[group] = view;
  }
  return out;
}

/** ADR-0149 의 활성 저장뷰 키. **승계 전용** — 쓰지 않고, 지우지도 않는다. */
const LEGACY_ACTIVE_VIEW_KEY = 'study.activeView.v1';
/** 탭 시절 저장소(ADR-0149 이전). `study.activeView.v1` 이 이미 승계한 사슬의 끝. */
const LEGACY_TABS_KEY = 'study.tabs.v1';

/**
 * 그룹 1 의 저장뷰를 옛 키에서 1회 승계한다 — **사슬은 두 홉이다**
 * (`study.tabs.v1` → `study.activeView.v1` → `groupViews[1]`).
 *
 * 끊으면 기존 사용자의 첫 진입이 **빈 화면**이 된다. ADR-0149 §3 이 적었듯 `/study` 에는
 * `live.page.v1` 같은 이중화가 없어 "마지막으로 보던 뷰" 의 집이 이 키들뿐이다 —
 * `/live` 가 ADR-0113 에서 옛 탭 키를 그냥 버릴 수 있었던 것과의 비대칭이 여기서도
 * 그대로 성립한다.
 *
 * 두 홉을 **한 함수에 둔 이유**: 첫 홉을 이미 마친 사용자와 아직 안 마친 사용자가
 * 동시에 존재하고(ADR-0149 가 4일 전이다), 둘 다 여기로 와야 한다.
 *
 * 승계 대상이 그룹 1 인 것은 임의가 아니다 — 기존 저장분의 창은 `readWindow` 폴백으로
 * 전부 그룹 1 이 되므로, 승계 직후 화면이 승계 전과 **같다**.
 *
 * 옛 키는 **지우지 않는다**(되돌리기 비용 최소화 — ADR-0149 와 같은 규율).
 */
function readLegacyGroupViewSeed(): Partial<Record<GroupId, StudyGroupView>> {
  // `readJsonObject` 는 부재·파손을 똑같이 `{}` 로 돌려주므로, 첫 홉의 존재 판정은
  // **`view` 키의 존재**로 한다. `{"view": null}`(뷰를 명시적으로 비운 상태)이 탭 키로
  // 되돌아가지 않게 하는 것이 이 구분의 목적이다.
  const own = readJsonObject(LEGACY_ACTIVE_VIEW_KEY);
  if ('view' in own) {
    const view = readGroupView(own.view);
    return view ? { [MIN_GROUP]: view } : {};
  }
  const snapshot = readJsonObject(LEGACY_TABS_KEY);
  const rawTabs = Array.isArray(snapshot.tabs) ? snapshot.tabs : [];
  const tabs = rawTabs.map(readGroupView).filter((v): v is StudyGroupView => v !== null);
  if (tabs.length === 0) return {};
  // clamp 는 **걸러낸 뒤의** 목록 길이 기준이다(ADR-0149 판과 동일) — 무효 탭이 앞에
  // 섞여 있을 때 인덱스가 밀리는 것을 감수하고, 범위 밖 접근을 없애는 쪽을 택한다.
  const rawIndex = Number.isInteger(snapshot.activeIndex) ? (snapshot.activeIndex as number) : 0;
  const index = Math.min(Math.max(0, rawIndex), tabs.length - 1);
  return { [MIN_GROUP]: tabs[index] };
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
 * BookPanel 의 폭 계약(`bookPanelMetrics`)은 절대 px 인데 비율 좌표계는 절대 하한을
 * 표현하지 못하므로(ADR-0122), 비율은 넓은 쪽 REF 가 아니라 **좁은 쪽 실측
 * (`NARROW_CANVAS_W`)에서 역산**한다 — 우측 열 = (1 − 0.58) × 1208 = 507px 로
 * `BOOK_WINDOW_DEFAULT_W`(487) 를 20px 넘긴다.
 *
 * 2026-08-16 에 하한이 560→448 로 내려오며 0.50 → 0.58 로 넓혔다(차트 595 → 690px).
 * 상한은 0.5968 (= 1 − 487/1208) 이고 그 위로 올리면 첫 시드부터 가로 스크롤이다.
 * 2026-08-18 에 중앙 가격 열 +10% 로 창 기본 폭이 480→487 이 되며 여유가 27→20px 로
 * 줄었지만 이 비율 자체는 그대로다 — `/live` 쪽(0.40)과 달리 여유가 넉넉했다.
 *
 * **"/study 캔버스가 /live 보다 작다" 는 전제는 2026-08-17 에 깨졌다** — 여백 통일로
 * 두 페이지 캔버스가 같아졌다(둘 다 1208×704 @1280). 그래서 기준이 `NARROW_CANVAS_W`
 * 하나로 합쳐졌고, `/live` 의 `DEFAULT_RIGHT_COL_W`(0.4)와 이 값이 다른 것은 이제
 * 캔버스 차이가 아니라 **페이지별 분할 취향**일 뿐이다(둘 다 하한은 만족).
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
 *
 * **배치만 만든다** — 반환 타입이 `Persisted` 가 아니라 `StudyWorkspaceSnapshot` 인
 * 것이 그 계약이다. 그룹→저장뷰는 시드의 입력(카드 순서/숨김)과 무관한 축이라
 * 호출부가 얹는다. 창은 전부 그룹 1 로 난다 — 첫 진입에 번호가 갈릴 이유가 없다.
 */
export function buildStudyWorkspaceSeed(layout: {
  cardOrder: readonly StudyCardKey[];
  cardHidden: Partial<Record<StudyCardKey, boolean>>;
}): StudyWorkspaceSnapshot {
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
    group: MIN_GROUP,
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
      group: MIN_GROUP,
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

/** 창 배열·zOrder 만 읽는 파생의 최소 입력 — 셀렉터로 그대로 넘길 수 있게 구조형. */
type StudyLayoutState = {
  windows: readonly StudyWorkspaceWindow[];
  zOrder: readonly string[];
};

/**
 * 포커스된 차트 창 = zOrder 최상단의 차트 창.
 *
 * 창이 여러 개일 때 **커서 해석·페이지 상태(로딩·에러)**가 이 창을 따른다(#801 단계 1).
 * 창이 하나면 그 창이므로 기존 동작과 같다.
 *
 * `group` 을 주면 **그 그룹 안에서만** 고른다(ADR-0154). 데이터 창이 "내 그룹의 어느
 * 차트 번들을 먹을까" 를 묻는 자리다 — 그룹을 무시하고 전역 포커스 차트를 먹이면
 * 그룹 2 의 10호가에 그룹 1 의 데이터가 뜬다.
 */
export function focusedChartWindowId(
  state: StudyLayoutState,
  group?: GroupId,
): string | null {
  const matches = (w: StudyWorkspaceWindow) =>
    w.kind === 'chart' && (group === undefined || w.group === group);
  for (let i = state.zOrder.length - 1; i >= 0; i -= 1) {
    const id = state.zOrder[i];
    if (state.windows.some((w) => w.id === id && matches(w))) return id;
  }
  return state.windows.find(matches)?.id ?? null;
}

/**
 * 활성 그룹 = 포커스 창(zOrder 마지막)의 그룹. 창이 없으면 1.
 *
 * `/live` `activeGroupOf` 의 미러이고 **저장하지 않는 것**까지 같다(#711) — 포커스에서
 * 파생하므로 두 번째 진실이 생기지 않는다. 저장뷰를 열 때(드로어 클릭·딥링크) 어느
 * 그룹에 꽂을지가 이 값이다.
 */
export function activeStudyGroup(state: StudyLayoutState): GroupId {
  const focusedId = state.zOrder[state.zOrder.length - 1];
  return state.windows.find((w) => w.id === focusedId)?.group ?? MIN_GROUP;
}

/** 이 창이 보는 저장뷰 — 창 → 그룹 → 저장뷰 **두 홉**. 창이 없으면 null. */
export function studyViewOfWindow(
  state: StudyLayoutState & { groupViews: Partial<Record<GroupId, StudyGroupView>> },
  windowId: string,
): StudyGroupView | null {
  const win = state.windows.find((w) => w.id === windowId);
  return win ? state.groupViews[win.group] ?? null : null;
}

/** 활성 그룹이 보는 저장뷰 — 페이지 헤더·탭 제목·드로어 선택 표시가 읽는 값. */
export function activeStudyView(
  state: StudyLayoutState & { groupViews: Partial<Record<GroupId, StudyGroupView>> },
): StudyGroupView | null {
  return state.groupViews[activeStudyGroup(state)] ?? null;
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
function ensureChartWindow(persisted: StudyWorkspaceSnapshot): StudyWorkspaceSnapshot {
  const windows = persisted.windows.map((w) =>
    w.kind === 'chart' && !w.chart ? { ...w, chart: seedChartConfig() } : w);
  if (windows.some((w) => w.kind === 'chart')) return { ...persisted, windows };
  const chart: StudyWorkspaceWindow = {
    id: newWindowId(),
    kind: 'chart',
    group: MIN_GROUP,
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
    groupViews: state.groupViews,
  };
  persistJson(STUDY_WORKSPACE_STORAGE_KEY, snapshot, 'tab');
  persistJson(STUDY_WORKSPACE_STORAGE_KEY, snapshot, 'shared');
}

/** raw 스냅샷 → canonical Persisted. 유효 창이 없으면 시드로 폴백(빈 워크스페이스로
 *  덮어써 창을 잃지 않게 — /live normalizeWorkspaceSnapshot 과 같은 규율). */
function normalizeSnapshot(raw: unknown): StudyWorkspaceSnapshot {
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
  /**
   * **키의 부재와 빈 맵은 다른 계약이다.** 부재일 때만 옛 키를 승계한다 — 빈 맵도
   * 승계하면 사용자가 마지막 저장뷰를 비운 것이 매 부팅마다 되살아난다(그리고 그
   * 되살아남은 옛 키를 지우지 않기로 한 결정 때문에 영구적이다).
   */
  const hasGroupViews = parsed.groupViews !== undefined;
  const groupViews = hasGroupViews
    ? readGroupViews(parsed.groupViews)
    : readLegacyGroupViewSeed();
  if (windows.length === 0) {
    const seed = { ...buildStudyWorkspaceSeed(readLegacyLayoutSeed()), groupViews };
    persistFromState(seed);
    return seed;
  }
  /**
   * **승계했다는 이유만으로는 굳히지 않는다** — 차트 설정 시드와 갈리는 지점이다.
   *
   * 저쪽은 굳혀야 한다: `study.lastMinuteTimeframe.v1` 은 살아 있는 키라, 안 굳히면
   * 매 방문이 그 값을 다시 읽어 사용자가 창에서 바꾼 봉을 덮는다.
   *
   * 여기는 반대다. `study.activeView.v1` 은 ADR-0154 로 **쓰는 사람이 사라진** 키라
   * 재읽기가 멱등이고, 승계 결과는 첫 변경(뷰 열기·창 드래그)에서 어차피 굳는다.
   * 반면 하이드레이션이 쓰기를 하면 **"새 탭은 열기만 해서는 아무것도 안 쓴다"** 는
   * 탭 격리 계약이 깨진다(공유 시드를 물려받은 탭이 즉시 자기 저장소를 만든다).
   */
  const seeded = needsChartConfigSeed(windows)
    || !windows.some((w) => w.kind === 'chart');
  const next = {
    ...ensureChartWindow({ windows, zOrder: normalizeZOrder(parsed.zOrder, windows) }),
    groupViews,
  };
  if (seeded) persistFromState(next);
  return next;
}

/**
 * 새 창 기본 크기(px 실측 → REF 캔버스로 비율화, /live DEFAULT_SIZE 와 같은 방식).
 * book/broker/vdist/program 은 /live 의 실측값을 그대로 쓴다 — 같은 카드 컴포넌트를
 * 렌더하므로 "전부 보이는 높이"의 근거가 같다. memo 는 StudyMemoPanel 텍스트영역
 * 기준 소형 카드.
 */
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

/** 지정한 창들의 비영속 런타임을 걷는다 = fresh-view (`/live` 동명 헬퍼 미러).
 *  저장뷰가 바뀌면 그 그룹 창들의 좌측 팬 백필 from-date 는 의미를 잃는다. */
function clearedChartRuntime(
  runtime: Record<string, ChartWindowRuntime>,
  ids: Iterable<string>,
): Record<string, ChartWindowRuntime> {
  const next = { ...runtime };
  for (const id of ids) delete next[id];
  return next;
}

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
    // 새 창이 복사할 지표의 원본 — `set` 전에 잡는다(`/live` addWindow 와 같은 이유).
    const indicatorSourceId = kind === 'chart' ? focusedChartWindowId(get()) : null;
    set((state) => {
      // 새 창 = **활성 그룹 상속**(#711 미러). 창을 하나 더 여는 흔한 동작이 지금 보던
      // 저장뷰를 그대로 이어받아야 "창 추가 → 뷰 다시 고르기" 가 되지 않는다.
      const group = activeStudyGroup(state);
      const size = DEFAULT_SIZE[kind];
      const frac = { w: size.w / REF_CANVAS.w, h: size.h / REF_CANVAS.h };
      // 캐스케이드 오프셋 — 새 창이 서로 겹쳐 나지 않도록 창 수에 비례해 밀어낸다.
      const offPx = 24 + ((state.windows.length * 28) % 200);
      const win: StudyWorkspaceWindow = {
        id,
        kind,
        group,
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
    // 새 차트 창은 포커스 창의 지표를 복사해서 연다(ADR-0152 — `/live` 미러).
    if (kind === 'chart') seedIndicatorScopeForWindow('study', id, indicatorSourceId);
    return id;
  },

  closeWindow: (id) => {
    // 닫기가 실제로 일어났을 때만 회수한다 — `canCloseStudyWindow` 가 마지막 차트
    // 창을 거부하는데, 그 no-op 에서 회수하면 **살아 있는 창**의 설정이 사라진다.
    const closed = get().windows.some((w) => w.id === id)
      && canCloseStudyWindow(get().windows, id);
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
    if (closed) dropIndicatorScopesForWindows('study', [id]);
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
    const before = get().windows;
    const layout = normalizeSnapshot(snapshot);
    set((state) => {
      // **`groupViews` 는 payload 에서 읽지 않는다** — 어떤 경로로 들어와도(프리셋 적용·
      // 왕복) 배치만 교체하고 지금 보고 있는 저장뷰는 그대로다. `/live` applySnapshot 이
      // `groupSymbols` 를 상태에서 되싣는 것과 같은 규율이다.
      const next = { ...layout, groupViews: state.groupViews };
      persistFromState(next);
      // 창 전면 교체 → 비영속 런타임을 걷는다(fresh-view, `/live` 미러).
      return { ...next, chartRuntime: {} };
    });
    // 사라진 창의 지표 스코프 회수(`/live` applyWorkspaceSnapshot 과 같은 규율).
    dropIndicatorScopesForRemovedWindows('study', before, get().windows);
  },

  setWindowGroup: (id, group) => {
    if (!isGroupId(group)) return;
    set((state) => {
      const prev = state.windows.find((w) => w.id === id);
      if (!prev || prev.group === group) return {};
      const windows = state.windows.map((w) => (w.id === id ? { ...w, group } : w));
      // 그룹 이동 = 이 창의 표시 저장뷰 교체(그룹=저장뷰 SSOT) — fresh-view 런타임 리셋.
      persistFromState({ ...state, windows });
      return { windows, chartRuntime: clearedChartRuntime(state.chartRuntime, [id]) };
    });
  },

  setGroupView: (group, view) => {
    if (!isGroupId(group)) return;
    set((state) => {
      const prev = state.groupViews[group];
      const groupViews = { ...state.groupViews, [group]: view };
      persistFromState({ ...state, groupViews });
      // **같은 뷰를 다시 여는 것은 멱등**이다(ADR-0149 `openSave` 계약 승계). 여기서
      // 런타임까지 리셋하면 드로어를 두 번 눌렀다는 이유만으로 진행 중이던 좌측 팬
      // 백필이 처음으로 되감긴다 — `/live` renameGroupSymbol 이 리셋을 피한 것과 같은
      // 판단이고, 판정은 `viewId` 하나로 한다(label·name 만 바뀐 것은 표시 문자열이다).
      if (prev?.viewId === view.viewId) return { groupViews };
      const affected = state.windows.filter((w) => w.group === group).map((w) => w.id);
      return { groupViews, chartRuntime: clearedChartRuntime(state.chartRuntime, affected) };
    });
  },

  clearGroupsOfView: (viewId) => {
    let cleared = false;
    set((state) => {
      const groups = Object.entries(state.groupViews)
        .filter(([, v]) => v?.viewId === viewId)
        .map(([key]) => Number(key) as GroupId);
      if (groups.length === 0) return {};
      cleared = true;
      const groupViews = { ...state.groupViews };
      const affected: string[] = [];
      for (const group of groups) {
        delete groupViews[group];
        for (const w of state.windows) if (w.group === group) affected.push(w.id);
      }
      persistFromState({ ...state, groupViews });
      return { groupViews, chartRuntime: clearedChartRuntime(state.chartRuntime, affected) };
    });
    return cleared;
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
export function snapshotStudyWorkspace(): StudyWorkspaceSnapshot {
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
