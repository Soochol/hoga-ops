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

/**
 * 두 pane 이름의 순서 위치를 교환한다. 둘 중 하나라도 candle 이거나(고정) 순서에
 * 없으면 원본 사본을 반환한다. 전체 순서에서 위치를 바꾸므로, 게이트로 부재중인
 * pane 을 사이에 두고도 "마운트된 이웃 스왑"이 올바르게 동작한다.
 */
export function swapInPaneOrder(order: readonly PaneId[], a: PaneId, b: PaneId): PaneId[] {
  if (a === 'candle' || b === 'candle' || a === b) return [...order];
  const ia = order.indexOf(a);
  const ib = order.indexOf(b);
  if (ia < 0 || ib < 0) return [...order];
  const next = [...order];
  next[ia] = b;
  next[ib] = a;
  return next;
}
