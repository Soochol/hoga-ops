import { useEffect, useState, type MutableRefObject } from 'react';
import { useDndContext } from '@dnd-kit/core';

/** Temporary hover expansion and velocity-scaled scrolling. Never persists collapse state. */
export function DragPanelAssist({ collapsed, onExpand, pointRef }: {
  collapsed: Set<string>; onExpand: (id: string) => void; pointRef: MutableRefObject<{ x: number; y: number } | null>;
}) {
  const { active, over, measureDroppableContainers } = useDndContext();
  const [hint, setHint] = useState<{ edge: 'up' | 'down'; top: number; left: number; width: number } | null>(null);
  const activeId = active?.id;
  const activeType = active?.data.current?.type;
  const target = over?.data.current?.folderId as string | undefined;
  useEffect(() => {
    if (activeType !== 'entry' || !target || !collapsed.has(target)) return;
    const timer = window.setTimeout(() => { onExpand(target); requestAnimationFrame(() => measureDroppableContainers([])); }, 600);
    return () => clearTimeout(timer);
  }, [activeId, activeType, target, collapsed, onExpand, measureDroppableContainers]);
  useEffect(() => {
    if (!activeId) return;
    const el = document.querySelector<HTMLElement>('[data-testid="watchlist-scroll"]');
    if (!el) return;
    const trackPointer = (event: PointerEvent) => { pointRef.current = { x: event.clientX, y: event.clientY }; };
    document.addEventListener('pointermove', trackPointer, true);
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const point = pointRef.current;
      const r = el.getBoundingClientRect();
      const zone = 48;
      let velocity = 0;
      if (point && point.x >= r.left && point.x <= r.right && point.y >= r.top && point.y <= r.bottom) {
        if (point.y < r.top + zone && el.scrollTop > 0) velocity = -Math.pow(1 - (point.y - r.top) / zone, 2) * 650;
        if (point.y > r.bottom - zone && el.scrollTop + el.clientHeight < el.scrollHeight) velocity = Math.pow(1 - (r.bottom - point.y) / zone, 2) * 650;
      }
      const next = velocity ? { edge: velocity < 0 ? 'up' as const : 'down' as const,
        top: velocity < 0 ? r.top : r.bottom, left: r.left, width: r.width } : null;
      setHint((old) => JSON.stringify(old) === JSON.stringify(next) ? old : next);
      if (velocity) el.scrollTop += velocity * Math.min(now - last, 32) / 1000;
      last = now;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('pointermove', trackPointer, true);
    };
  }, [activeId, pointRef]);
  if (!active || !hint) return null;
  return <div role="status" className="pointer-events-none fixed z-50 bg-tint-selection py-1 text-center text-xs text-accent"
    style={{ top: hint.top, left: hint.left, width: hint.width, transform: hint.edge === 'down' ? 'translateY(-100%)' : undefined }}>
    {hint.edge === 'up' ? '↑ 위로 스크롤' : '↓ 아래로 스크롤'}
  </div>;
}
