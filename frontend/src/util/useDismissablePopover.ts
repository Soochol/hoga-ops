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
): void {
  useEffect(() => {
    if (!isOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (anchorRef.current?.contains(e.target as Node)) return;
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
  }, [isOpen, anchorRef, onDismiss]);
}
