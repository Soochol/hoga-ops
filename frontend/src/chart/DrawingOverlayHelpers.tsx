import type { Drawing } from './drawing/types';
import { isLocked } from './drawing/types';


/** What the window-level mousedown listener should do in select mode. */
export type SelectModeMouseDown = 'deselect' | 'select-locked' | 'none';


/**
 * Pure decision for the window-level mousedown listener in select mode.
 *
 * Two jobs, one predicate, because they are decided by the same three facts
 * (where the click landed, what it hit, whether it came from the panel):
 *
 *  - `'deselect'` — the empty-click rule (ADR-0030): a click inside the
 *    overlay's rect that hit no Drawing clears the selection.
 *  - `'select-locked'` — the click hit a locked Drawing AND nothing unlocked.
 *    The overlay does not receive that click at all (the pointer-events gate
 *    deliberately leaves it `'none'` there so the chart can pan), so
 *    `selectTool` never runs and this listener is the only thing that can
 *    select it. Without this branch a locked drawing could never be selected,
 *    and therefore never unlocked — the panel's lock button is the only unlock
 *    route (ADR-0164).
 *  - `'none'` — everything else, including any click where an UNLOCKED Drawing
 *    is under the cursor: there the overlay is `'auto'` and
 *    `selectTool.onPointerDown` owns the selection.
 *
 * `unlockedHit` is what splits the last two, and it is the SAME value the
 * pointer-events gate keys on — that is the point. Deciding from `hit` alone
 * breaks when a locked drawing overlaps an unlocked one: `hit` is the locked
 * one (topmost wins), so this listener would fire `'select-locked'` on a click
 * the overlay is already handling. `pointerdown` precedes `mousedown`, so the
 * overlay's selection of the live shape would land first and then be
 * overwritten here — the user grabs one shape and watches another get
 * selected. Both sides keying on the gate's own question keeps their territory
 * split exactly at the gate, with no overlap.
 *
 * The property-panel guard is load-bearing: the panel renders over the
 * chart (its pixels fall inside the overlay's rect by construction), and
 * its `mousedown` events bubble up to the window listener. Without the
 * guard, the user's own mousedown on a panel control (color / thickness /
 * lineStyle trigger) clears `selectedId` before the trigger's onClick
 * fires, unmounting the panel and silently dropping the edit. The delete
 * button worked anyway because it captures `id` in a closure that
 * survives selectedId going null, masking the bug. See ADR-0030 (the
 * deselect rule) and ADR-0032 (the panel that demands this exception).
 *
 * The inside-rect test is also what keeps this multi-window safe: the listener
 * is on `window`, so every chart window's copy sees every click. Only the one
 * whose rect contains the click acts, so a click in window A can never write a
 * selection into window B's scope (the misattribution ADR-0119 C2c-2b exists
 * to prevent).
 */
export function resolveSelectModeMouseDown(
  click: { x: number; y: number },
  rect: { width: number; height: number },
  hit: Drawing | null,
  unlockedHit: Drawing | null,
  isOnPropertyPanel: boolean,
  shiftKey: boolean,
): SelectModeMouseDown {
  if (isOnPropertyPanel) return 'none';
  // Shift 가 눌린 클릭은 **선택을 더하는 제스처**이고, 그 처리자는 오버레이다
  // (토글 또는 마퀴 시작). 이 리스너는 window 에 붙어 있어 게이트와 무관하게
  // 모든 mousedown 을 보므로, 여기서 걸러 내지 않으면 마퀴를 시작하려고 빈 곳을
  // 누르는 순간 'deselect' 가 나가 **애써 모은 집합이 통째로 사라진다**. 도형을
  // 빗맞힌 Shift+클릭도 마찬가지다. 다중 선택에서 가장 아픈 종류의 실수라,
  // 판정 자체를 modifier 로 끊는다.
  if (shiftKey) return 'none';
  const inside =
    click.x >= 0 &&
    click.y >= 0 &&
    click.x <= rect.width &&
    click.y <= rect.height;
  if (!inside) return 'none';
  // 잠기지 않은 것이 하나라도 커서 아래 있으면 게이트가 'auto' 이고, 그 클릭의
  // 주인은 오버레이다. 여기서 손대면 두 번 쓴다.
  if (unlockedHit != null) return 'none';
  if (hit == null) return 'deselect';
  // 여기 도달했다면 hit 은 잠긴 것이다(잠기지 않았다면 unlockedHit 에 잡혔다).
  // 그래도 명시적으로 확인한다 — 두 히트 테스트가 언젠가 임계값이 갈리면 이
  // 함의가 조용히 깨지는데, 그때 엉뚱한 도형을 선택하느니 아무것도 안 하는 게 낫다.
  return isLocked(hit) ? 'select-locked' : 'none';
}


/** Test-only export of internals. Do not import in production code. */
export const __test__ = { resolveSelectModeMouseDown };
