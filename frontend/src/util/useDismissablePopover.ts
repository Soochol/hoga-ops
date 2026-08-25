// frontend/src/util/useDismissablePopover.ts
//
// Single-owner of the "popover dismissal" contract used across the
// codebase: an open floating affordance closes on outside mousedown or
// Escape, and does NOT close on a mousedown inside its anchor.
//
// Pre-this-helper, the same ~17-line useEffect was reproduced verbatim
// in DrawingMenu, DrawingPropertyPanel, SymbolSearch, DateRangePicker,
// and StockCombobox. The shape was uniform but every site re-declared
// the keydown predicate and the ref-contains check independently — a
// recipe for slow drift (one site listens on `document`, another on
// `window`; one uses `mousedown`, another adds `pointerdown`).
//
// This module concentrates the contract. Listeners are only mounted
// while `isOpen` is true (zero cost when closed). Anchor-internal
// mousedown is suppressed so the trigger button can toggle without
// the global handler immediately closing what it just opened.

import { useEffect, type RefObject } from 'react';

/**
 * 열려 있는 포털 레이어들 — **중첩 팝오버**의 dismiss 를 가르기 위한 모듈 상태.
 *
 * 팝오버 안에서 또 팝오버가 열릴 수 있다(레전드 칩 속성 팝오버 → 그 안의 MA 스타일
 * 팔레트). 둘 다 body 로 포털되므로 **서로의 서브트리 밖**이고, 안쪽 팔레트를 누르면
 * 바깥 팝오버가 그것을 "바깥 클릭" 으로 읽어 닫힌다 — 그러면 트리거가 통째로
 * 언마운트돼 `click` 이 영영 오지 않고, 사용자는 **색을 고를 수 없다**.
 *
 * 판별식은 **열린 순서**다: 나보다 **나중에** 열린 레이어 안의 클릭은 내 바깥이
 * 아니다. 형제 팝오버가 이 규칙에 걸리지 않는 이유는 애초에 공존할 수 없기 때문이다 —
 * 형제를 열려면 그 트리거를 눌러야 하고, 그 mousedown 이 먼저 나를 닫는다. 즉 두
 * 팝오버가 동시에 열려 있다는 것 자체가 **중첩**의 증거다.
 */
const openLayers = new Map<number, RefObject<HTMLElement | null>>();
let nextLayerToken = 1;

export function useDismissablePopover(
  isOpen: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  onDismiss: () => void,
  /** 포털로 body 에 떠 있는 레이어의 ref(선택). `createPortal` 을 쓰면 팝오버 DOM 이
   *  `anchorRef` 서브트리 **밖**이라 팝오버 내부 mousedown 이 "바깥" 으로 잡힌다 —
   *  누르는 순간 닫히고 `click` 은 영영 오지 않아 선택이 통째로 죽는다(그런데
   *  `fireEvent.click` 은 mousedown 을 안 쏘므로 기존 테스트는 전부 초록으로 남는다).
   *  레이어 ref 를 함께 넘기면 그 안의 mousedown 도 앵커와 동등하게 억제한다.
   *  `FolderAddButton` 이 인라인 effect 로 복붙하던 예외를 이 계약 안으로 들인 것. */
  layerRef?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!isOpen) return;
    // 열린 순서표. 리스너와 **같은 effect** 에서 발급·해제해야 한다 — 따로 두면
    // 토큰이 없는 프레임이 생겨 중첩 판정이 샌다.
    const token = nextLayerToken++;
    if (layerRef) openLayers.set(token, layerRef);
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (anchorRef.current?.contains(target)) return;
      if (layerRef?.current?.contains(target)) return;
      // 내 안에서 열린(=나중에 열린) 팝오버 안의 클릭은 내 바깥이 아니다 — 위 주석.
      for (const [otherToken, otherLayer] of openLayers) {
        if (otherToken > token && otherLayer.current?.contains(target)) return;
      }
      onDismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKey);
    return () => {
      openLayers.delete(token);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [isOpen, anchorRef, onDismiss, layerRef]);
}
