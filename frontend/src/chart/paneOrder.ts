import type { PaneId } from './drawing/types';
import { normalizeKeyOrder } from '../state/keyOrder';

/**
 * 사용자 소유 차트 pane 순서 (ADR-0114 §3).
 *
 * canonical 순서 = `PANE_SPECS`(candle..program-trade) 배열 순서 + investor 2종.
 * 순서는 array index 가 아니라 **PaneId 이름 배열**로 저장되므로 드로잉 영속 키
 * (ADR-0028)를 침범하지 않는다. 멤버십은 `paneSpecsForTimeframe` 의 게이트가 소유하고,
 * 이 순서는 순열일 뿐이다.
 *
 * 이 배열을 `paneSpecs.PANE_SPECS` 에서 파생하지 않고 손으로 나열하는 이유는
 * import 사이클 회피다: `paneSpecs` → `projectors/ratio` → `state/livePage` →
 * `liveIndicatorsPersistence`(이 파일을 import) 로 순환이 생긴다. 대신 아래
 * `_exhaustive` 가드가 PaneId 유니온을 전부 커버하는지 컴파일 타임에 강제한다 —
 * 새 pane 을 추가하면 이 배열을 갱신하지 않는 한 tsc 가 실패한다.
 */
export const CANONICAL_PANE_ORDER = [
  'candle',
  'volume',
  'quote-totals',
  'peak-wall',
  'ratio',
  'fill-strength',
  'program-trade',
  'investor-foreign',
  'investor-institution',
] as const satisfies readonly PaneId[];

// PaneId 유니온이 늘어나면 이 할당이 실패한다(위 배열에 새 pane 추가를 강제).
type _CanonicalCoversAllPaneIds = PaneId extends (typeof CANONICAL_PANE_ORDER)[number]
  ? true
  : never;
const _exhaustive: _CanonicalCoversAllPaneIds = true;
void _exhaustive;

const CANONICAL_SET = new Set<string>(CANONICAL_PANE_ORDER);

function isPaneId(value: string): value is PaneId {
  return CANONICAL_SET.has(value);
}

/**
 * 저장된 pane 순서를 정규화한다: unknown 드롭·중복 제거·누락 append 후 **candle 을
 * index 0 으로 강제**한다. candle 은 timeScale/드로잉/오버레이 앵커라 절대 이동 불가
 * (ADR-0114 §3) — 저장값이 candle 을 다른 위치에 두더라도 여기서 맨 앞으로 끌어온다.
 */
export function normalizePaneOrder(raw: unknown): PaneId[] {
  const normalized = normalizeKeyOrder(raw, CANONICAL_PANE_ORDER, isPaneId);
  const withoutCandle = normalized.filter((id) => id !== 'candle');
  return ['candle', ...withoutCandle];
}

/** 사용자 소유 Pane 크기 가중치(Pane Stretch) — pane 종류별 상대 높이 가중치.
 *  전역 1세트(타임프레임·페이지 공통): 크기는 "캔들 크게, 거래량 얇게" 같은 공간
 *  취향이지 타임프레임 내용이 아니다. 없는 키 = 스펙 기본값(`spec.stretch`) 사용. */
export type PaneStretchMap = Partial<Record<PaneId, number>>;

// 스펙 기본값이 0.3~1.4 스케일이므로 [0.05, 20] 밖은 손상된 저장값으로 간주해 드롭
// (lwc 렌더는 MinPaneHeight 30px 로 자체 바닥이 있지만, 극단값이 다른 pane 을
// 사실상 0 으로 짓누르는 것을 저장 단계에서 차단).
const STRETCH_MIN = 0.05;
const STRETCH_MAX = 20;

/** 저장된 Pane Stretch 를 정규화한다: PaneId 아닌 키·비유한·범위 밖 값 드롭. */
export function normalizePaneStretch(raw: unknown): PaneStretchMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: PaneStretchMap = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isPaneId(k)) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    if (v < STRETCH_MIN || v > STRETCH_MAX) continue;
    out[k] = v;
  }
  return out;
}

/**
 * `pane` 을 전역 순서에서 빼내 `neighbor` 바로 앞/뒤에 다시 끼운다(레전드 ↑/↓).
 *
 * **위치 교환(swap)이 아니라 인접 삽입인 이유**: 단일 전역 paneOrder 는 여러
 * 타임프레임이 공유하는데(D 는 investor, 분봉은 호가 pane 만 마운트), swap 은
 * 이웃을 상대의 전역 슬롯으로 보내 **다른 타임프레임 뷰에서 그 이웃이 튀는**
 * leapfrog 를 일으킨다. 인접 삽입은 `pane` 만 이웃 옆으로 최소 이동시켜, 게이트로
 * 부재중인 pane 들의 상대 위치를 보존한다. candle 은 이동 금지(고정).
 */
export function movePaneBeside(
  order: readonly PaneId[],
  pane: PaneId,
  neighbor: PaneId,
  side: 'before' | 'after',
): PaneId[] {
  if (pane === 'candle' || pane === neighbor) return [...order];
  const without = order.filter((id) => id !== pane);
  const ni = without.indexOf(neighbor);
  if (ni < 0) return [...order];
  without.splice(side === 'before' ? ni : ni + 1, 0, pane);
  return without;
}

/**
 * pane 의 한글 표시 이름. **exhaustive** — `PaneId` 를 늘리면 tsc 가 여기를 요구한다.
 *
 * ⚠ `PaneSpec.legendTitle` 과 혼동하지 말 것. 그건 pane 의 이름이 아니라 **레전드 셀
 * 앞에 붙는 제목 접두사**이고, 셀 라벨이 이미 pane 을 말해 주는 pane(거래량·호가비·
 * 프로그램 순매수…)에는 **일부러 없다** — 넣으면 화면에 `거래량 거래량 40,586` 처럼
 * 두 번 나온다. 그래서 `legendTitle` 을 이름으로 쓰면 정의된 2개(총잔량·체결강도)만
 * 한글이고 나머지는 영문 paneId 로 샌다(이 표가 생긴 이유).
 *
 * 값은 보조지표 패널(`live/indicators/IndicatorPanel.tsx` 의 `CATEGORIES`)과 같은
 * 이름을 쓴다 — 같은 pane 을 두 화면이 다르게 부르면 안 되므로 그 파일의
 * 드리프트 테스트가 두 표를 대조한다. 캔들은 패널에 항목이 없다(끌 수 없는 고정 pane).
 */
export const PANE_DISPLAY_NAME: Record<PaneId, string> = {
  candle: '캔들',
  volume: '거래량',
  ratio: '호가비',
  'quote-totals': '총잔량',
  'fill-strength': '체결강도',
  'program-trade': '프로그램 순매수',
  'investor-foreign': '외국인 순매수량',
  'investor-institution': '기관 순매수량',
  'peak-wall': '최대벽',
};
