import { useEffect, useRef, useState, type ReactNode } from 'react';

export function BrokerScrollArea({ children }: { children: ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const el = viewport.current;
    const body = content.current;
    if (!el || !body) return;
    const update = () => setMore(el.scrollHeight - el.clientHeight - el.scrollTop > 1);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(el);
    observer?.observe(body);
    el.addEventListener('scroll', update, { passive: true });
    update();
    return () => { observer?.disconnect(); el.removeEventListener('scroll', update); };
  }, []);
  return <div className="relative min-h-0 flex-1">
    <div ref={viewport} tabIndex={0} role="region" aria-label="거래원 목록" className="h-full overflow-auto">
      <div ref={content}>{children}</div>
    </div>
    {more && <button type="button" className="absolute bottom-0 left-1/2 -translate-x-1/2 rounded bg-bg-card px-2 py-0.5 text-2xs text-accent shadow-overlay"
      onClick={() => viewport.current?.scrollBy({ top: viewport.current.clientHeight / 2 })}>거래원 더 보기 ↓</button>}
  </div>;
}
