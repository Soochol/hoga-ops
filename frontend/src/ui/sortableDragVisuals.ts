import type { CSSProperties } from 'react';

export type DropIndicator = 'before' | 'after';
export type DropIndicatorAxis = 'vertical' | 'horizontal';

export function dropIndicatorClass(dropIndicator?: DropIndicator, axis: DropIndicatorAxis = 'vertical'): string {
  if (axis === 'horizontal') {
    if (dropIndicator === 'before') {
      return "before:content-[''] before:absolute before:left-[-5px] before:top-[-4px] before:z-10 before:h-3 before:w-3 before:rounded-full before:border-2 before:border-[var(--accent)] before:bg-bg-card after:content-[''] after:absolute after:left-0 after:top-0 after:bottom-0 after:z-10 after:w-0.5 after:bg-[var(--accent)]";
    }
    if (dropIndicator === 'after') {
      return "before:content-[''] before:absolute before:right-[-5px] before:top-[-4px] before:z-10 before:h-3 before:w-3 before:rounded-full before:border-2 before:border-[var(--accent)] before:bg-bg-card after:content-[''] after:absolute after:right-0 after:top-0 after:bottom-0 after:z-10 after:w-0.5 after:bg-[var(--accent)]";
    }
    return '';
  }
  if (dropIndicator === 'before') {
    return "before:content-[''] before:absolute before:left-[-4px] before:top-[-5px] before:z-10 before:h-3 before:w-3 before:rounded-full before:border-2 before:border-[var(--accent)] before:bg-bg-card after:content-[''] after:absolute after:left-0 after:right-0 after:top-0 after:z-10 after:h-0.5 after:bg-[var(--accent)]";
  }
  if (dropIndicator === 'after') {
    return "before:content-[''] before:absolute before:left-[-4px] before:bottom-[-5px] before:z-10 before:h-3 before:w-3 before:rounded-full before:border-2 before:border-[var(--accent)] before:bg-bg-card after:content-[''] after:absolute after:left-0 after:right-0 after:bottom-0 after:z-10 after:h-0.5 after:bg-[var(--accent)]";
  }
  return '';
}

/** `DragOverlay` 고스트를 쓰는 리스트의 **원본 슬롯** 스타일.
 *
 *  고스트가 커서에 들려 있으므로 원본 행은 "들어올려진 것"이 아니라 **삽입될 빈 자리**다
 *  (DESIGN.md 345행: "원래 슬롯 opacity 0 placeholder"). 여기에 `sortableDraggingStyle`
 *  의 틴트를 같이 걸면 같은 행이 화면에 두 번 보인다. 행 높이는 `min-h-list-row` 고정이라
 *  숨겨도 reflow 가 흔들리지 않는다. */
export function sortablePlaceholderStyle(): CSSProperties {
  return { opacity: 0 };
}

export function sortableDraggingStyle(tintPercent = 14): CSSProperties {
  return {
    opacity: 0.72,
    cursor: 'grabbing',
    zIndex: 1,
    position: 'relative',
    background: `color-mix(in srgb, var(--accent) ${tintPercent}%, var(--bg-card))`,
    boxShadow: '0 8px 18px rgba(0, 0, 0, 0.14)',
  };
}
