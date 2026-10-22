import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { getStockDescription } from './stockDescriptions';

export const STOCK_DESCRIPTION_DELAY_MS = 500;
const LEAVE_DELAY_MS = 120;
const EDGE_PX = 8;

interface ActiveDescription {
  anchor: HTMLElement;
  code: string;
  captureTitle?: string;
}

interface TooltipActions {
  show: (anchor: HTMLElement, code: string | undefined, captureTitle?: string) => void;
  hide: () => void;
  scheduleHide: () => void;
}

const TooltipContext = createContext<TooltipActions | null>(null);
export const useStockDescriptionTooltip = () => useContext(TooltipContext);

/** One timer/portal/listener set per board or live workspace, including duplicate Codes. */
export function StockDescriptionTooltipProvider({ children, disabled = false }: { children: ReactNode; disabled?: boolean }) {
  const id = useId();
  const [active, setActive] = useState<ActiveDescription | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const cancelTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const hide = useCallback(() => { cancelTimer(); setActive(null); }, [cancelTimer]);
  const scheduleHide = useCallback(() => {
    cancelTimer();
    timer.current = setTimeout(hide, LEAVE_DELAY_MS);
  }, [cancelTimer, hide]);
  const show = useCallback((anchor: HTMLElement, code: string | undefined, captureTitle?: string) => {
    hide();
    if (disabled || !code || !getStockDescription(code)) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      if (anchor.isConnected) setActive({ anchor, code, captureTitle });
    }, STOCK_DESCRIPTION_DELAY_MS);
  }, [disabled, hide]);
  const actions = useMemo(() => ({ show, hide, scheduleHide }), [show, hide, scheduleHide]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') hide(); };
    const onVisibility = () => { if (document.visibilityState === 'hidden') hide(); };
    window.addEventListener('pointerdown', hide, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      cancelTimer();
      window.removeEventListener('pointerdown', hide, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      window.removeEventListener('blur', hide);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [cancelTimer, hide]);
  useEffect(() => { if (disabled) hide(); }, [disabled, hide]);

  useLayoutEffect(() => {
    if (!active || !panel.current) return;
    if (!active.anchor.isConnected) { hide(); return; }
    const anchor = active.anchor.getBoundingClientRect();
    const box = panel.current.getBoundingClientRect();
    const left = Math.max(EDGE_PX, Math.min(anchor.left, window.innerWidth - box.width - EDGE_PX));
    const below = anchor.bottom + EDGE_PX;
    const top = below + box.height <= window.innerHeight - EDGE_PX
      ? below
      : Math.max(EDGE_PX, Math.min(anchor.top - box.height - EDGE_PX, window.innerHeight - box.height - EDGE_PX));
    panel.current.style.left = `${left}px`;
    panel.current.style.top = `${top}px`;
    // Keyboard focus belongs to the row; pointer hover belongs to its name span.
    const owner = active.anchor.closest('[role="button"]') ?? active.anchor;
    const previous = owner.getAttribute('aria-describedby');
    owner.setAttribute('aria-describedby', [previous, id].filter(Boolean).join(' '));
    const observer = new MutationObserver(() => { if (!active.anchor.isConnected) hide(); });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (previous === null) owner.removeAttribute('aria-describedby');
      else owner.setAttribute('aria-describedby', previous);
    };
  }, [active, hide, id]);

  const description = active ? getStockDescription(active.code) : undefined;
  return <TooltipContext.Provider value={actions}>
    {children}
    {active && description && createPortal(
      <div ref={panel} id={id} role="tooltip" data-testid="stock-description-tooltip"
        onMouseEnter={cancelTimer} onMouseLeave={scheduleHide}
        className="fixed z-50 w-80 max-w-[calc(100vw-1rem)] rounded-lg border border-border-strong bg-bg-card p-3 text-sm text-fg shadow-[var(--shadow)]"
        style={{ left: 0, top: 0 }}>
        <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="font-semibold">{description.name}</span>
          <span className="font-data text-xs text-fg-dim">{active.code}</span>
        </div>
        <div className="leading-relaxed [word-break:keep-all] [overflow-wrap:anywhere]" data-testid="stock-description-lines">
          {description.lines.map((line) => <div key={line}>{line}</div>)}
        </div>
        {active.captureTitle && <div className="mt-2 border-t border-border pt-2 text-xs text-fg-dim">{active.captureTitle}</div>}
      </div>, document.body,
    )}
  </TooltipContext.Provider>;
}
