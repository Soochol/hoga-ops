import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Keep the complete fixed-row ladder reachable when a saved window is smaller than its contents. */
export function BookScrollArea({ children }: { children: ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false, up: false, down: false });
  useEffect(() => {
    const el = viewport.current;
    const body = content.current;
    if (!el || !body) return;
    const update = () => {
      const next = {
        left: el.scrollLeft > 1,
        right: el.scrollWidth - el.clientWidth - el.scrollLeft > 1,
        up: el.scrollTop > 1,
        down: el.scrollHeight - el.clientHeight - el.scrollTop > 1,
      };
      setEdges((prev) => Object.keys(next).every((key) => prev[key as keyof typeof next] === next[key as keyof typeof next]) ? prev : next);
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(el);
    observer?.observe(body);
    el.addEventListener('scroll', update, { passive: true });
    update();
    return () => { observer?.disconnect(); el.removeEventListener('scroll', update); };
  }, []);
  const horizontal = edges.left || edges.right;
  const vertical = edges.up || edges.down;
  const button = 'rounded px-1.5 py-0.5 text-accent hover:bg-tint-selection disabled:text-fg-dimmer disabled:cursor-default';
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={viewport} tabIndex={0} role="region" aria-label="10호가 사다리와 요약" className="min-h-0 flex-1 overflow-auto">
        <div ref={content}>{children}</div>
      </div>
      {(horizontal || vertical) && (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-t border-border px-1 text-xs text-fg-dim" aria-label="호가 스크롤 이동">
          <span>숨겨진 {horizontal && vertical ? '행·열' : horizontal ? '열' : '행'}</span>
          {horizontal && <>
            <button type="button" className={button} disabled={!edges.left} onClick={() => viewport.current?.scrollTo({ left: 0 })}>← 잔량</button>
            <button type="button" className={button} disabled={!edges.right} onClick={() => viewport.current?.scrollTo({ left: viewport.current.scrollWidth })}>요약 →</button>
          </>}
          {vertical && <>
            <button type="button" className={button} disabled={!edges.up} onClick={() => viewport.current?.scrollTo({ top: 0 })}>↑ 매도</button>
            <button type="button" className={button} disabled={!edges.down} onClick={() => viewport.current?.scrollTo({ top: viewport.current.scrollHeight })}>매수 ↓</button>
          </>}
        </div>
      )}
    </div>
  );
}
