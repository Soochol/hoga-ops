import type { KeyboardEvent, PointerEvent } from 'react';
import type { DraggableSyntheticListeners } from '@dnd-kit/core';

/** 행 전체를 잡되 입력·체크·정렬 같은 내부 컨트롤은 독립적으로 조작한다. */
export function panelDragListeners(listeners: DraggableSyntheticListeners): DraggableSyntheticListeners {
  if (!listeners) return undefined;
  return {
    ...listeners,
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement;
      const control = target.closest('button, input, textarea, select, a, [contenteditable="true"]');
      if (control && !control.hasAttribute('data-panel-drag-label')) return;
      listeners.onPointerDown?.(event);
    },
  };
}

/** 포커스된 행에서도 마우스 우클릭과 같은 메뉴를 연다. */
export function openPanelContextMenuFromKeyboard(event: KeyboardEvent<HTMLElement>): boolean {
  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return false;
  if ((event.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return false;
  event.preventDefault();
  event.stopPropagation();
  const rect = event.currentTarget.getBoundingClientRect();
  event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: rect.left + 12, clientY: rect.bottom,
  }));
  return true;
}
