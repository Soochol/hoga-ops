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
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (anchorRef.current?.contains(target)) return;
      if (layerRef?.current?.contains(target)) return;
      onDismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [isOpen, anchorRef, onDismiss, layerRef]);
}
