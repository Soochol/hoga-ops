import { useEffect, useReducer, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useClampedFixedPosition } from '../util/useClampedFixedPosition';
import { useDismissablePopover } from '../util/useDismissablePopover';

/** 차트 하트와 우측 패널 메뉴가 공유하는 관심 그룹 팝오버 표면. */
export function WatchlistGroupPopover({ x, y, role, label, testId, onClose, anchorRef, children }: {
  x: number;
  y: number;
  role: 'dialog' | 'menu';
  label: string;
  testId: string;
  onClose: () => void;
  anchorRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const { ref, left, top } = useClampedFixedPosition<HTMLDivElement>(x, y);
  useDismissablePopover(true, anchorRef ?? ref, onClose, ref);
  const [, measure] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    // 그룹 조회·검색·저장 안내로 자식 높이가 바뀌어도 화면 경계를 다시 확인한다.
    if (!ref.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(ref.current);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [ref]);

  return createPortal(
    <div ref={ref} role={role} aria-label={label} data-testid={testId}
      onPointerDown={event => event.stopPropagation()}
      onContextMenu={event => event.preventDefault()}
      onKeyDown={event => {
        if (event.key !== 'Escape') return;
        // This portal can be nested in the stock search. Escape belongs to
        // the group picker, not its React parent or the chart behind it.
        event.stopPropagation();
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        event.preventDefault();
        onClose();
        anchorRef?.current?.focus({ preventScroll: true });
      }}
      className="z-[60] flex max-h-[calc(100vh-16px)] w-[var(--watchlist-panel-w)] max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-lg border border-border bg-bg-card py-1 shadow-overlay"
      style={{ position: 'fixed', left, top }}>
      {children}
    </div>, document.body,
  );
}
