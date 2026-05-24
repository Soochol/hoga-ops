import { useEffect, useRef } from 'react';

/**
 * Reusable vertical splitter — a thin grid track the user drags to resize
 * adjacent regions. Knows nothing about the parent layout; emits raw
 * cursor X and lets the parent map clientX → its own value space
 * (px or percent, axis direction).
 *
 * Visual: a 12px-wide grab zone with a 2px-thick bar centered inside,
 * `var(--border)` by default and `var(--accent)` on hover (per the
 * 2026-05-20 design system). Double-click resets; arrow keys nudge.
 */

type Props = {
  /** Called on every drag move with the raw cursor X (clientX). */
  onDrag: (clientX: number) => void;
  /** Called on double-click and on Enter/Space. */
  onReset: () => void;
  /** Optional keyboard nudge handler. direction: -1 (left) | +1 (right). */
  onNudge?: (direction: -1 | 1, magnitude: 'small' | 'large') => void;
  ariaLabel: string;
  ariaValueNow: number;
  ariaValueMin: number;
  ariaValueMax: number;
};

export default function VerticalSplitter({
  onDrag,
  onReset,
  onNudge,
  ariaLabel,
  ariaValueNow,
  ariaValueMin,
  ariaValueMax,
}: Props) {
  const draggingRef = useRef(false);
  // Hold latest onDrag in a ref so the window mousemove handler always
  // sees the freshest closure without re-registering listeners.
  const onDragRef = useRef(onDrag);
  useEffect(() => {
    onDragRef.current = onDrag;
  }, [onDrag]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      onDragRef.current(e.clientX);
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      // Defensive cleanup in case unmount happens mid-drag.
      if (draggingRef.current) {
        draggingRef.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
  }, []);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onReset();
      return;
    }
    if (!onNudge) return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      onNudge(-1, e.shiftKey ? 'large' : 'small');
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      onNudge(1, e.shiftKey ? 'large' : 'small');
    } else if (e.key === 'Home') {
      e.preventDefault();
      onNudge(-1, 'large');
    } else if (e.key === 'End') {
      e.preventDefault();
      onNudge(1, 'large');
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      aria-valuenow={ariaValueNow}
      aria-valuemin={ariaValueMin}
      aria-valuemax={ariaValueMax}
      tabIndex={0}
      onMouseDown={onMouseDown}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      title="드래그하여 크기 조정 · 더블클릭으로 초기화"
      className="cursor-col-resize flex items-stretch justify-center bg-transparent select-none focus:outline-none"
    >
      <div
        aria-hidden
        className="w-[2px] rounded-[1px] bg-[var(--border)] transition-[background-color,width] duration-150 hover:w-1 hover:bg-[var(--accent)]"
      />
    </div>
  );
}
