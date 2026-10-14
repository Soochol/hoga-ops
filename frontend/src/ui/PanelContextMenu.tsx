import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useClampedFixedPosition } from '../util/useClampedFixedPosition';
import { useDismissablePopover } from '../util/useDismissablePopover';

/** 고정 헤더와 스크롤 영역 밖에 표시하는 그룹 우클릭 메뉴. */
export function PanelContextMenu({ point, label, showLabel = true, onClose, children, className = '' }: {
  point: { x: number; y: number };
  label: string;
  showLabel?: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const { ref, left, top } = useClampedFixedPosition<HTMLDivElement>(point.x, point.y);
  useDismissablePopover(true, ref, onClose, ref);
  useEffect(() => {
    const trigger = document.activeElement;
    const menu = ref.current;
    menu?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    return () => {
      if ((document.activeElement === document.body || menu?.contains(document.activeElement))
        && trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, [ref]);
  return createPortal(
    <div ref={ref} role="menu" aria-label={label}
      onPointerDown={event => event.stopPropagation()}
      onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
      className={`fixed z-[60] min-w-[150px] max-h-[calc(100vh-16px)] max-w-[calc(100vw-16px)] overflow-y-auto rounded-lg border border-border bg-bg-card py-1 shadow-overlay ${className}`}
      style={{ left, top }}>
      {showLabel && <div className="px-3 py-1 text-xs text-fg-dim">{label}</div>}
      {children}
    </div>, document.body,
  );
}
