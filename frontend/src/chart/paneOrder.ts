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
