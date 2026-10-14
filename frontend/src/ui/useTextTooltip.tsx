import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** Portal keeps a long name visible outside the clipped, scrolling list. */
export function useTextTooltip(text: string, delayMs = 0, className = '') {
  const id = useId();
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const [active, setActive] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hide = useCallback(() => {
    if (timer.current != null) clearTimeout(timer.current);
    timer.current = null;
    setActive(false);
    setAnchor(null);
  }, []);
  useEffect(() => () => { if (timer.current != null) clearTimeout(timer.current); }, []);
  useEffect(() => { if (!text) hide(); }, [text, hide]);
  useEffect(() => {
    if (!active) return;
    const dismiss = hide;
    // Switching tabs can skip mouseleave on the hovered stock name.
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') dismiss();
    };
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [active, hide]);
  return {
    id: anchor ? id : undefined,
    show: (element: HTMLElement) => {
      if (!text) return;
      if (timer.current != null) clearTimeout(timer.current);
      setActive(true);
      const reveal = () => {
        timer.current = null;
        if (!element.isConnected) { hide(); return; }
        const rect = element.getBoundingClientRect();
        setAnchor({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 288)), top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 72)) });
      };
      if (delayMs > 0) timer.current = setTimeout(reveal, delayMs);
      else reveal();
    },
    hide,
    tooltip: anchor ? createPortal(<div id={id} role="tooltip"
      className={`pointer-events-none fixed z-50 max-w-72 rounded border border-border-strong bg-bg-card px-2 py-1 text-xs text-fg shadow-panel ${className}`}
      style={anchor}>{text}</div>, document.body) : null,
  };
}
