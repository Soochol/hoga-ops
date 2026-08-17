/**
 * 워크스페이스 마이그레이션 — 레거시 키 → `live.workspace.v1` 1회 시드 (ADR-0119 PR-C, #713).
 *
 * `live.workspace.v1` 이 아직 없을 때, 사용자의 기존 단일 뷰 상태(`live.page.v1`·
 * `live.indicators.v2`·`live.layout.v1`)에서 초기 워크스페이스를 구성한다:
 *  - `live.page.v1`  → 그룹 1 종목 + 첫 차트 창의 timeframe
 *  - `live.indicators.v2` → **존재 여부만** 본다("기존 사용자인가" 신호). 지표
 *    설정은 앱 전역 1세트라 창에 실을 것이 없다 — 그 키를 그대로 쓴다.
 *  - `live.layout.v1` 카드 순서·숨김 → 데이터 창 배치(숨긴 카드는 창 미생성)
 *
 * 시드 변환은 순수 함수(`buildWorkspaceSeed`)로 격리해 결정론적 단위 테스트로 고정하고,
 * localStorage 읽기(부수효과)는 얇은 래퍼(`readLegacyWorkspaceSeed`)가 담당한다.
 * 구 키는 이후 사용하지 않는다(1회 시드 관례 — `live.indicators.v1→v2` 계승).
 */
import { readJsonObject } from './persist';
import { INDICATORS_V2_STORAGE_KEY } from './indicatorSettingsV2';
import {
  LIVE_TIMEFRAMES,
  LIVE_PAGE_STORAGE_KEY,
  MINUTE_TIMEFRAMES,
  type LiveTimeframe,
  type MinuteTimeframe,
} from './livePage';
import { LIVE_CARD_KEYS, LIVE_LAYOUT_STORAGE_KEY, type LiveCardKey } from './liveLayout';
import { isLiveInstrument } from '../live/liveInstrument';
import { LIVE_RIGHT_COL_W, LIVE_RIGHT_COL_X } from './liveDefaultLayout';
import type { WorkspaceWindow, GroupSymbol, WindowKind } from './workspace';

export interface WorkspaceSeed {
  windows: WorkspaceWindow[];
  zOrder: string[];
  groupSymbols: Partial<Record<number, GroupSymbol>>;
}

/** 상세 카드 키 → 데이터 창 종류. */
const CARD_TO_KIND: Record<LiveCardKey, WindowKind> = {
  orderbook: 'book',
  brokers: 'broker',
  volumeDistribution: 'vdist',
  program: 'program',
  investor: 'investor',
};

// 시드 배치는 **비율**이다(ADR-0122) — 분할 상수는 공장 기본과 같은 것을 쓴다
// (`liveDefaultLayout.ts`). 종전 px 상수(PAD 16 · CHART_W 720 · DATA_W 236 ·
// COL_GAP 12 · TOTAL_H 760)는 전부 사라졌다. 경위는 `buildWorkspaceSeed` 주석.

function isLiveCardKey(value: unknown): value is LiveCardKey {
  return typeof value === 'string' && (LIVE_CARD_KEYS as readonly string[]).includes(value);
}

function isLiveTimeframe(value: unknown): value is LiveTimeframe {
  return typeof value === 'string' && (LIVE_TIMEFRAMES as readonly string[]).includes(value);
}

/** 저장된 카드 순서를 유효 키만·중복제거·숨김제외로 정규화해 데이터 창 목록을 만든다. */
function visibleCardsInOrder(layout: Record<string, unknown>): LiveCardKey[] {
  const hidden = (layout.rightCardHidden ?? {}) as Partial<Record<LiveCardKey, boolean>>;
  const rawOrder = Array.isArray(layout.rightCardOrder) ? layout.rightCardOrder : LIVE_CARD_KEYS;
  const seen = new Set<LiveCardKey>();
  const ordered: LiveCardKey[] = [];
  for (const entry of rawOrder) {
    if (isLiveCardKey(entry) && !seen.has(entry)) {
      seen.add(entry);
      ordered.push(entry);
    }
  }
  // 저장 순서에 없던 canonical 카드는 뒤에 붙인다(신규 카드 하위호환).
  for (const key of LIVE_CARD_KEYS) if (!seen.has(key)) ordered.push(key);
  return ordered.filter((key) => hidden[key] !== true);
}

/** 그룹 1 종목 — 주식={code,name}, 지수={code:id, kind:'index'}(C2c-2c 정식 지원). */
function groupOneSymbol(page: Record<string, unknown>): GroupSymbol | null {
  const inst = page.activeInstrument;
  if (isLiveInstrument(inst) && inst.kind === 'stock') {
    return { code: inst.code, name: inst.label };
  }
  if (isLiveInstrument(inst) && inst.kind === 'index') {
    return { code: inst.id, name: inst.label, kind: 'index' };
  }
  if (typeof page.activeCode === 'string' && page.activeCode) {
    return { code: page.activeCode, name: page.activeCode };
  }
  return null;
}

/**
 * 레거시 파싱 객체들에서 초기 워크스페이스 시드를 만든다. 순수 함수.
 * 세 키가 모두 비어(마이그레이션할 상태 없음) 있으면 null → 호출측이 공장 기본을 쓴다.
 *
 * ## rect 는 비율이다 — px 였던 것이 조용한 데이터 손실이었다 (2026-08-17)
 *
 * 종전 이 함수는 px rect(`{x:16, y:16, w:720, h:760}`)를 냈고, 호출측이
 * `pendingNormalize: true` 로 표시해 캔버스 첫 실측 때 비율화하려 했다. 그런데 시드는
 * **즉시 persist** 되고 `persistFromState` 는 항상 `schema_version: 2`(비율)로 태그한다.
 * 그래서 저장소에는 **px 값이 v2 로 태그된 스냅샷**이 남았고, 다음 로드에서
 * `readRect(legacyPx=false)` 의 `isFracRect`(`w <= 1.0001`)가 전부 떨어뜨렸다 →
 * `windows.length === 0` → 공장 기본 폴백.
 *
 * 실측(재현 테스트): 시드 직후 창 6개 · 봉 `D` → **새로고침 후 창 3개 · 봉 `1m` ·
 * id 전부 교체 · 종목 유실**. 즉 마이그레이션이 물려받으려던 카드 순서·숨김·봉·종목이
 * 첫 새로고침에 전멸했다. 증상이 "새로고침하면 레이아웃이 초기화된다" 라 저장 실패로
 * 보이지만, 실제 원인은 **좌표계 태그 불일치**다.
 *
 * 비율로 만들면 시드가 곧 v2 라 태그가 참이 되고, 정규화 왕복도 필요 없다(호출측이
 * `pendingNormalize: false`). 여백은 갖지 않는다 — 소유자는 `WORKSPACE_PAGE_PAD` 다.
 *
 * 데이터 창 높이는 **균등 분할**로 남긴다(종전 `floor(TOTAL_H / n)` 과 동형). 공장
 * 기본·`/study` 시드가 10호가에 3배 가중을 주는 것과 다르지만, 이 경로의 목적은 옛
 * 사용자의 카드 순서·숨김을 **그대로** 옮기는 것이라 배치 정책까지 바꾸지 않는다.
 * 폭 계약은 균등 분할과 무관하게 지켜진다(`LIVE_RIGHT_COL_W`), 높이는 broker 처럼
 * 스크롤로 산다.
 */

function isMinuteFrameValue(value: unknown): value is MinuteTimeframe {
  return typeof value === 'string' && (MINUTE_TIMEFRAMES as readonly string[]).includes(value);
}

export function buildWorkspaceSeed(
  legacy: { page?: unknown; indicators?: unknown; layout?: unknown },
  makeId: () => string,
): WorkspaceSeed | null {
  const page = (legacy.page && typeof legacy.page === 'object' ? legacy.page : {}) as Record<string, unknown>;
  const layout = (legacy.layout && typeof legacy.layout === 'object' ? legacy.layout : {}) as Record<string, unknown>;
  const hasPage = Object.keys(page).length > 0;
  const hasLayout = Object.keys(layout).length > 0;
  const hasIndicators = legacy.indicators != null;
  if (!hasPage && !hasLayout && !hasIndicators) return null;

  const timeframe = isLiveTimeframe(page.candleTimeframe) ? page.candleTimeframe : '1m';
  // 분봉 기억 시드 — 레거시 저장값 우선, 없으면 현재 분봉에서 파생(livePage 미러).
  const lastMinuteTimeframe = isMinuteFrameValue(page.lastMinuteTimeframe)
    ? page.lastMinuteTimeframe
    : isMinuteFrameValue(timeframe)
      ? timeframe
      : undefined;

  const dataCards = hasLayout ? visibleCardsInOrder(layout) : [...LIVE_CARD_KEYS];

  const windows: WorkspaceWindow[] = [];
  const zOrder: string[] = [];

  // 차트 창(그룹 1) — 데이터 창이 없으면 캔버스 전폭을 쓴다.
  const chartId = makeId();
  const n = dataCards.length;
  windows.push({
    id: chartId,
    kind: 'chart',
    group: 1,
    rect: { x: 0, y: 0, w: n > 0 ? LIVE_RIGHT_COL_X : 1, h: 1 },
    chart: {
      timeframe,
      ...(lastMinuteTimeframe ? { lastMinuteTimeframe } : {}),
    },
  });
  zOrder.push(chartId);

  // 데이터 창 — 우측 열에 세로 균등 스택(숨긴 카드는 생성 안 함). 마지막 창의 높이는
  // 남은 몫으로 잡아 스택이 정확히 1 에서 끝나게 한다(1/3 같은 값의 누적 오차 방지).
  dataCards.forEach((card, i) => {
    const id = makeId();
    const y = i / n;
    windows.push({
      id,
      kind: CARD_TO_KIND[card],
      group: 1,
      rect: { x: LIVE_RIGHT_COL_X, y, w: LIVE_RIGHT_COL_W, h: i === n - 1 ? 1 - y : 1 / n },
    });
    zOrder.push(id);
  });

  const symbol = groupOneSymbol(page);
  const groupSymbols: Partial<Record<number, GroupSymbol>> = symbol ? { 1: symbol } : {};

  return { windows, zOrder, groupSymbols };
}

/**
 * 레거시 localStorage 키를 읽어 워크스페이스 시드를 만든다. 없으면 null.
 * `workspace.ts` 의 하이드레이션이 `live.workspace.v1` 부재 시 호출한다.
 */
export function readLegacyWorkspaceSeed(makeId: () => string): WorkspaceSeed | null {
  const page = readJsonObject(LIVE_PAGE_STORAGE_KEY);
  const indicatorsRaw = readJsonObject(INDICATORS_V2_STORAGE_KEY);
  const layout = readJsonObject(LIVE_LAYOUT_STORAGE_KEY);
  return buildWorkspaceSeed(
    {
      page: Object.keys(page).length > 0 ? page : undefined,
      indicators: Object.keys(indicatorsRaw).length > 0 ? indicatorsRaw : undefined,
      layout: Object.keys(layout).length > 0 ? layout : undefined,
    },
    makeId,
  );
}
