import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import type { OrderPriceRange } from './orderPriceRange';
import { ORDER_ROW_HEIGHT } from './orderRules';

/** A bounded window into the full price ladder. Market updates never change its
 * anchor; only explicit navigation does. Native wheel handling avoids React's
 * passive wheel listener and preserves browser zoom/horizontal scrolling. */
export function useOrderPriceExplorer(context: string, range: OrderPriceRange | null, currentPrice: number | null, locked: boolean, viewportRef: RefObject<HTMLDivElement>) {
  const [view, setView] = useState<{ context: string; top: number | null }>(() => ({ context, top: null }));
  if (view.context !== context || (view.top != null && !range)) setView({ context, top: null });
  const [rowCount, setRowCount] = useState(20);
  const [panning, setPanning] = useState(false);
  const pan = useRef<{ pointer: number; y: number; index: number; active: boolean } | null>(null);
  const enabled = view.context === context && view.top != null && !!range;
  const count = Math.min(rowCount, range?.count ?? 20);
  const maxStart = Math.max(0, (range?.count ?? 0) - count);
  const start = enabled && range && view.top != null ? Math.min(maxStart, range.indexOf(view.top)) : 0;
  const moveTo = useCallback((index: number) => {
    if (range) setView({ context, top: range.priceAt(Math.max(0, Math.min(maxStart, index))) });
  }, [context, range, maxStart]);
  const centerCurrent = () => {
    if (range && currentPrice != null && currentPrice > 0) moveTo(range.indexOf(currentPrice) - Math.floor(count / 2));
  };
  const toggle = () => {
    if (enabled) setView({ context, top: null });
    else centerCurrent();
  };
  useLayoutEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const measure = () => {
      if (node.clientHeight > 0) setRowCount(Math.max(1, Math.floor((node.clientHeight - 32) / ORDER_ROW_HEIGHT)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [viewportRef]);
  useLayoutEffect(() => {
    // The regular twenty-row layout may have been scrolled in a short window.
    if (viewportRef.current) viewportRef.current.scrollTop = 0;
  }, [enabled, viewportRef]);
  useEffect(() => {
    if (!enabled) return;
    const node = viewportRef.current;
    if (!node) return;
    let remainder = 0;
    // Accumulate against the DOM-independent anchor even if several wheel
    // events arrive before React commits the next frame.
    let index = start;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY) || locked || pan.current) return;
      event.preventDefault();
      remainder += event.deltaY * (event.deltaMode === 1 ? ORDER_ROW_HEIGHT : event.deltaMode === 2 ? node.clientHeight : 1);
      const steps = Math.trunc(remainder / ORDER_ROW_HEIGHT);
      if (steps) {
        remainder -= steps * ORDER_ROW_HEIGHT;
        index = Math.max(0, Math.min(maxStart, index + steps));
        moveTo(index);
      }
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, [enabled, start, locked, maxStart, moveTo, viewportRef]);
  const cancelPan = useCallback(() => {
    const active = pan.current;
    pan.current = null;
    if (active && viewportRef.current?.hasPointerCapture(active.pointer)) viewportRef.current.releasePointerCapture(active.pointer);
    setPanning(false);
  }, [viewportRef]);
  useEffect(() => cancelPan, [context, enabled, cancelPan]);
  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!enabled || locked || event.button !== 0 || !(event.target instanceof Element) || !event.target.closest('[data-price-pan]')) return;
    event.preventDefault(); event.stopPropagation();
    pan.current = { pointer: event.pointerId, y: event.clientY, index: start, active: false };
    setPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
  }
  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const active = pan.current;
    if (!active || active.pointer !== event.pointerId) return;
    event.stopPropagation();
    const dy = event.clientY - active.y;
    if (Math.abs(dy) >= 6) active.active = true;
    if (active.active) moveTo(active.index - Math.trunc(dy / ORDER_ROW_HEIGHT));
  }
  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    if (pan.current?.pointer !== event.pointerId) return;
    event.stopPropagation(); cancelPan();
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!enabled || locked || pan.current || event.target !== event.currentTarget) return;
    const target = { ArrowUp: start - 1, ArrowDown: start + 1, PageUp: start - count,
      PageDown: start + count, Home: 0, End: maxStart }[event.key];
    if (target == null) return;
    event.preventDefault(); event.stopPropagation(); moveTo(target);
  }
  return { enabled, panning, toggle, centerCurrent, cancelPan,
    onPointerDown, onPointerMove, onPointerUp, onKeyDown,
    prices: enabled && range ? Array.from({ length: count }, (_, i) => range.priceAt(start + i)) : [],
  };
}
