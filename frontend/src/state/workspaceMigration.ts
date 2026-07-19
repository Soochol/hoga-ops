/**
 * 워크스페이스 마이그레이션 — 레거시 키 → `live.workspace.v1` 1회 시드 (ADR-0119 PR-C, #713).
 *
 * `live.workspace.v1` 이 아직 없을 때, 사용자의 기존 단일 뷰 상태(`live.page.v1`·
 * `live.indicators.v2`·`live.layout.v1`)에서 초기 워크스페이스를 구성한다:
 *  - `live.page.v1`  → 그룹 1 종목 + 첫 차트 창의 timeframe
 *  - `live.indicators.v2` → 첫 차트 창의 지표 설정(#712 창 소유)
 *  - `live.layout.v1` 카드 순서·숨김 → 데이터 창 배치(숨긴 카드는 창 미생성)
 *
 * 시드 변환은 순수 함수(`buildWorkspaceSeed`)로 격리해 결정론적 단위 테스트로 고정하고,
 * localStorage 읽기(부수효과)는 얇은 래퍼(`readLegacyWorkspaceSeed`)가 담당한다.
 * 구 키는 이후 사용하지 않는다(1회 시드 관례 — `live.indicators.v1→v2` 계승).
 */
import { readJsonObject } from './persist';
import { normalizeIndicatorsV2 } from './indicatorSettingsV2';
import { LIVE_TIMEFRAMES, LIVE_PAGE_STORAGE_KEY, type LiveTimeframe } from './livePage';
import {
  LIVE_CARD_KEYS,
  LIVE_LAYOUT_STORAGE_KEY,
  type LiveCardKey,
} from './liveLayout';
import { INDICATORS_V2_STORAGE_KEY } from './indicatorSettingsV2';
import { isLiveInstrument } from '../live/liveInstrument';
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

// 시드 레이아웃 상수(스토어는 canvas 크기를 모르므로 고정 px — defaultWindows 관례).
const PAD = 16;
const CHART_W = 720;
const DATA_W = 236;
const COL_GAP = 12;
const TOTAL_H = 760;
const DATA_X = PAD + CHART_W + COL_GAP; // 748

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

/** 그룹 1 종목 — 활성 instrument 가 주식이면 {code,name}, 그 외(지수·없음)면 없음. */
function groupOneSymbol(page: Record<string, unknown>): GroupSymbol | null {
  const inst = page.activeInstrument;
  if (isLiveInstrument(inst) && inst.kind === 'stock') {
    return { code: inst.code, name: inst.label };
  }
  if (typeof page.activeCode === 'string' && page.activeCode) {
    return { code: page.activeCode, name: page.activeCode };
  }
  return null;
}

/**
 * 레거시 파싱 객체들에서 초기 워크스페이스 시드를 만든다. 순수 함수.
 * 세 키가 모두 비어(마이그레이션할 상태 없음) 있으면 null → 호출측이 공장 기본을 쓴다.
 */
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
  const indicators = normalizeIndicatorsV2(legacy.indicators);

  const dataCards = hasLayout ? visibleCardsInOrder(layout) : [...LIVE_CARD_KEYS];

  const windows: WorkspaceWindow[] = [];
  const zOrder: string[] = [];

  // 차트 창(그룹 1) — 데이터 창이 없으면 폭을 넓혀 화면을 채운다.
  const chartId = makeId();
  const chartW = dataCards.length > 0 ? CHART_W : CHART_W + COL_GAP + DATA_W;
  windows.push({
    id: chartId,
    kind: 'chart',
    group: 1,
    rect: { x: PAD, y: PAD, w: chartW, h: TOTAL_H },
    chart: { timeframe, indicators },
  });
  zOrder.push(chartId);

  // 데이터 창 — 우측 열에 세로 스택(숨긴 카드는 생성 안 함).
  const n = dataCards.length;
  const dataH = n > 0 ? Math.floor(TOTAL_H / n) : 0;
  dataCards.forEach((card, i) => {
    const id = makeId();
    windows.push({
      id,
      kind: CARD_TO_KIND[card],
      group: 1,
      rect: { x: DATA_X, y: PAD + i * dataH, w: DATA_W, h: dataH },
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
