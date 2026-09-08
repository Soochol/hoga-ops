import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';

/** Portal keeps a long name visible outside the clipped, scrolling list. */
export function useTextTooltip(text: string) {
  const id = useId();
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const hide = () => setAnchor(null);
  useEffect(() => {
    if (!anchor) return;
    const dismiss = () => setAnchor(null);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [anchor]);
  return {
    id: anchor ? id : undefined,
    show: (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      setAnchor({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 288)), top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 72)) });
    },
    hide,
    tooltip: anchor ? createPortal(<div id={id} role="tooltip"
      className="pointer-events-none fixed z-50 max-w-72 rounded border border-border-strong bg-bg-card px-2 py-1 text-xs text-fg shadow-panel"
      style={anchor}>{text}</div>, document.body) : null,
  };
}
