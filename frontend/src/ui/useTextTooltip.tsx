import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './TextTooltip.css';

/** Portal keeps a long name visible outside the clipped, scrolling list. */
export function useTextTooltip(text: string, delayMs = 0, className = '', hoverOnly = false) {
  const id = useId();
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const [active, setActive] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hide = useCallback(() => {
    if (timer.current != null) clearTimeout(timer.current);
    timer.current = null;
    trigger.current = null;
    setActive(false);
    setAnchor(null);
  }, []);
  useEffect(() => () => { if (timer.current != null) clearTimeout(timer.current); }, []);
  useEffect(() => { if (!text) hide(); }, [text, hide]);
  // Measure the actual content instead of reserving a fixed 288×72px box.
  // Flip above the trigger at the bottom edge, then keep an 8px viewport inset.
  useLayoutEffect(() => {
    if (!anchor || !panel.current || !trigger.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const { width, height } = panel.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const below = rect.bottom + 4;
    const top = Math.max(8, Math.min(below + height <= window.innerHeight - 8 ? below : rect.top - height - 4,
      window.innerHeight - height - 8));
    if (anchor.left !== left || anchor.top !== top) setAnchor({ left, top });
  }, [anchor, text]);
  useEffect(() => {
    if (!active) return;
    const dismiss = hide;
    // Switching tabs can skip mouseleave on the hovered stock name.
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') dismiss();
    };
    // Hover does not move keyboard focus to the anchor. Escape still dismisses it.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    const onOtherTooltip = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== id) dismiss();
    };
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('hoga:tooltip-open', onOtherTooltip);
    return () => {
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('hoga:tooltip-open', onOtherTooltip);
    };
  }, [active, hide, id]);
  const show = useCallback((element: HTMLElement) => {
    if (!text) return;
    document.dispatchEvent(new CustomEvent('hoga:tooltip-open', { detail: id }));
    trigger.current = element;
    if (timer.current != null) clearTimeout(timer.current);
    setActive(true);
    const reveal = () => {
      timer.current = null;
      if (!element.isConnected) { hide(); return; }
      // A workspace window can cover an anchor without delivering mouseleave.
      if (hoverOnly && !element.matches(':hover')) { hide(); return; }
      const rect = element.getBoundingClientRect();
      setAnchor({ left: rect.left, top: rect.bottom + 4 });
    };
    if (delayMs > 0) timer.current = setTimeout(reveal, delayMs);
    else reveal();
  }, [text, delayMs, hoverOnly, hide, id]);
  return {
    id: anchor ? id : undefined,
    show,
    // Programmatic/pointer focus alone is not a hover. Keep keyboard access explicit.
    showOnFocus: (element: HTMLElement) => {
      if (element.matches(':focus-visible')) show(element);
    },
    hide,
    tooltip: anchor ? createPortal(<div ref={panel} id={id} role="tooltip"
      className={`tooltip-surface text-tooltip ${className}`.trim()}
      style={anchor}>{text}</div>, document.body) : null,
  };
}
