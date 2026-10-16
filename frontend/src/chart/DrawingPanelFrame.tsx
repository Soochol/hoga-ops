import { useCallback, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';

type Position = { x: number; y: number };
// Page memory only. Window IDs survive chart remounts; a reload clears this map.
const positions = new Map<string, Position>();
const MARGIN = 8;
const DIRECTIONS: Record<string, readonly [number, number]> = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
};
const clamp = (n: number, max: number) => Math.max(MARGIN, Math.min(n, Math.max(MARGIN, max)));

function bounds(panel: HTMLDivElement) {
  const parent = panel.offsetParent as HTMLElement | null;
  if (!parent || !parent.clientWidth || !parent.clientHeight) return null;
  return { parent, maxX: Math.max(MARGIN, parent.clientWidth - panel.offsetWidth - MARGIN),
    maxY: Math.max(MARGIN, parent.clientHeight - panel.offsetHeight - MARGIN) };
}

function fraction(left: number, top: number, box: NonNullable<ReturnType<typeof bounds>>): Position {
  return { x: left / box.parent.clientWidth, y: top / box.parent.clientHeight };
}

export function DrawingPanelFrame({ positionKey, testId, onMove, children }: {
  positionKey: string;
  testId: string;
  onMove: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const remembered = useRef(positions.get(positionKey) ?? null);
  const drag = useRef<{
    pointerId: number; x: number; y: number; left: number; top: number;
    previous: Position | null; moved: boolean;
  } | null>(null);

  const place = useCallback(() => {
    const panel = panelRef.current;
    const box = panel && bounds(panel);
    if (!panel || !box) return;
    const point = remembered.current;
    if (!point) {
      panel.style.top = `${MARGIN}px`;
      panel.style.left = '50%';
      panel.style.transform = 'translateX(-50%)';
      return;
    }
    panel.style.transform = 'none';
    panel.style.left = `${clamp(point.x * box.parent.clientWidth, box.maxX)}px`;
    panel.style.top = `${clamp(point.y * box.parent.clientHeight, box.maxY)}px`;
  }, []);

  const cancel = useCallback(() => {
    if (!drag.current) return;
    remembered.current = drag.current.previous;
    drag.current = null;
    place();
  }, [place]);

  useLayoutEffect(() => {
    place();
    const panel = panelRef.current;
    const parent = panel?.offsetParent;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    if (panel) observer?.observe(panel);
    if (parent) observer?.observe(parent);
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !drag.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancel();
    };
    document.addEventListener('keydown', escape, true);
    return () => {
      observer?.disconnect();
      document.removeEventListener('keydown', escape, true);
    };
  }, [place, cancel]);

  const reset = () => {
    cancel();
    remembered.current = null;
    positions.delete(positionKey);
    place();
  };

  return <div ref={panelRef} data-drawing-property-panel data-testid={testId}
    className="absolute z-30 inline-flex flex-wrap items-center gap-0.5 bg-bg-card border border-border rounded-lg p-1 shadow-lg"
    style={{ top: MARGIN, left: '50%', transform: 'translateX(-50%)', width: 'max-content', maxWidth: 'calc(100% - 16px)' }}>
    <button type="button" data-testid="drawing-panel-grip" aria-label="그리기 옵션 이동"
      title="드래그·방향키로 이동 · 더블클릭·Home으로 기본 위치"
      className="h-7 w-4 shrink-0 touch-none cursor-grab active:cursor-grabbing inline-flex items-center justify-center rounded text-fg-dim hover:bg-bg-input-hover"
      onDoubleClick={reset}
      onPointerDown={event => {
        if (event.button !== 0) return;
        const panel = panelRef.current;
        if (!panel || !bounds(panel)) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY,
          left: panel.offsetLeft - (remembered.current ? 0 : panel.offsetWidth / 2),
          top: panel.offsetTop, previous: remembered.current, moved: false };
      }}
      onPointerMove={event => {
        const active = drag.current;
        const panel = panelRef.current;
        const box = panel && bounds(panel);
        if (!active || active.pointerId !== event.pointerId || !panel || !box) return;
        const dx = event.clientX - active.x, dy = event.clientY - active.y;
        if (!active.moved && Math.hypot(dx, dy) < 5) return;
        if (!active.moved) onMove();
        active.moved = true;
        remembered.current = fraction(clamp(active.left + dx, box.maxX), clamp(active.top + dy, box.maxY), box);
        place();
      }}
      onPointerUp={event => {
        const active = drag.current;
        if (!active || active.pointerId !== event.pointerId) return;
        if (active.moved && remembered.current) positions.set(positionKey, remembered.current);
        drag.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      onKeyDown={event => {
        if (event.key === 'Home') {
          event.preventDefault(); event.stopPropagation(); reset(); return;
        }
        const delta = DIRECTIONS[event.key];
        const panel = panelRef.current;
        const box = panel && bounds(panel);
        if (!delta || !panel || !box) return;
        event.preventDefault(); event.stopPropagation(); onMove();
        const step = event.shiftKey ? 10 : 1;
        remembered.current = fraction(
          clamp(panel.offsetLeft - (remembered.current ? 0 : panel.offsetWidth / 2) + delta[0] * step, box.maxX),
          clamp(panel.offsetTop + delta[1] * step, box.maxY), box);
        positions.set(positionKey, remembered.current);
        place();
      }}>
      <svg aria-hidden="true" width="8" height="16" viewBox="0 0 8 16" fill="currentColor">
        {[4, 8, 12].map(y => <g key={y}><circle cx="2" cy={y} r="1" /><circle cx="6" cy={y} r="1" /></g>)}
      </svg>
    </button>
    {children}
  </div>;
}

/** A moved toolbar can sit near any edge; its menus must still open inside the chart. */
export function DrawingPanelPopover({ popoverRef, className, children }: {
  popoverRef: RefObject<HTMLDivElement>; className: string; children: ReactNode;
}) {
  useLayoutEffect(() => {
    const menu = popoverRef.current;
    const toolbar = menu?.offsetParent as HTMLElement | null;
    const chart = toolbar?.offsetParent as HTMLElement | null;
    if (!menu || !toolbar || !chart) return;
    const place = () => {
      const owner = chart.getBoundingClientRect(), bar = toolbar.getBoundingClientRect();
      const below = Math.max(0, owner.bottom - bar.bottom - MARGIN - 4);
      const above = Math.max(0, bar.top - owner.top - MARGIN - 4);
      const flip = menu.scrollHeight > below && above > below;
      menu.style.top = flip ? 'auto' : 'calc(100% + 4px)';
      menu.style.bottom = flip ? 'calc(100% + 4px)' : 'auto';
      menu.style.maxHeight = `${flip ? above : below}px`;
      menu.style.overflowY = 'auto';
      menu.style.left = `${Math.max(owner.left + MARGIN, Math.min(bar.left, owner.right - menu.offsetWidth - MARGIN)) - bar.left}px`;
    };
    place();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(chart);
    observer?.observe(menu);
    return () => observer?.disconnect();
  }, [popoverRef]);
  return <div ref={popoverRef} className={className}>{children}</div>;
}
