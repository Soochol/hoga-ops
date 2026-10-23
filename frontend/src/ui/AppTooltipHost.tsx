import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTextTooltip } from './useTextTooltip';

type Target = { element: HTMLElement; text: string; source: 'pointer' | 'focus' };

function tooltipTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest<HTMLElement>('[data-tooltip], [data-tooltip-trigger]');
  // Title bars intentionally have no action hints. Their company descriptions
  // are owned by StockDescriptionTooltip, not the delegated text host.
  if (!element || element.hasAttribute('data-tooltip-trigger') || element.closest('.live-window-titlebar')) return null;
  return element;
}

/** One event/timer/portal set for text hints across routes, portals and virtual lists. */
export function AppTooltipHost() {
  const [target, setTarget] = useState<Target | null>(null);
  const current = useRef<Target | null>(null);
  const { show, hide, id, tooltip } = useTextTooltip(target?.text ?? '', 500);
  const showRef = useRef(show);
  useLayoutEffect(() => { showRef.current = show; }, [show]);
  const element = target?.element;

  useEffect(() => {
    const select = (element: HTMLElement | null, source: Target['source']) => {
      const text = element?.getAttribute('data-tooltip')?.trim();
      if (element === current.current?.element && text === current.current.text) return;
      current.current = element && text ? { element, text, source } : null;
      setTarget(current.current);
    };
    const clear = () => select(null, 'pointer');
    const pointerOver = (event: PointerEvent) => {
      if (event.buttons === 0 && event.pointerType !== 'touch') select(tooltipTarget(event.target), 'pointer');
    };
    const pointerOut = (event: PointerEvent) => {
      if (current.current?.source === 'pointer') select(tooltipTarget(event.relatedTarget), 'pointer');
    };
    const focusIn = (event: FocusEvent) => {
      if (event.target instanceof Element && event.target.matches(':focus-visible')) select(tooltipTarget(event.target), 'focus');
    };
    const focusOut = () => { if (current.current?.source === 'focus') clear(); };
    const keyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') clear(); };
    const visibility = () => { if (document.visibilityState === 'hidden') clear(); };
    document.addEventListener('pointerover', pointerOver, true);
    document.addEventListener('pointerout', pointerOut, true);
    document.addEventListener('focusin', focusIn, true);
    document.addEventListener('focusout', focusOut, true);
    document.addEventListener('pointerdown', clear, true);
    document.addEventListener('keydown', keyDown, true);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('scroll', clear, true);
    window.addEventListener('resize', clear);
    window.addEventListener('blur', clear);
    return () => {
      document.removeEventListener('pointerover', pointerOver, true);
      document.removeEventListener('pointerout', pointerOut, true);
      document.removeEventListener('focusin', focusIn, true);
      document.removeEventListener('focusout', focusOut, true);
      document.removeEventListener('pointerdown', clear, true);
      document.removeEventListener('keydown', keyDown, true);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('scroll', clear, true);
      window.removeEventListener('resize', clear);
      window.removeEventListener('blur', clear);
    };
  }, []);

  // Live values can change while hovered; update the content without restarting
  // the initial delay or reopening a hint dismissed with Escape.
  useEffect(() => { if (element) showRef.current(element); else hide(); }, [element, hide]);

  useEffect(() => {
    if (!target) return;
    const observer = new MutationObserver(() => {
      const text = target.element.getAttribute('data-tooltip')?.trim();
      if (!target.element.isConnected || !text) {
        current.current = null; setTarget(null);
      } else if (text !== target.text) {
        const next = { ...target, text }; current.current = next; setTarget(next);
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-tooltip'] });
    return () => observer.disconnect();
  }, [target]);

  useLayoutEffect(() => {
    if (!id || !target) return;
    const element = target.element;
    element.setAttribute('aria-describedby', [element.getAttribute('aria-describedby'), id].filter(Boolean).join(' '));
    return () => {
      const remaining = element.getAttribute('aria-describedby')?.split(/\s+/).filter(value => value !== id).join(' ');
      if (remaining) element.setAttribute('aria-describedby', remaining);
      else element.removeAttribute('aria-describedby');
    };
  }, [id, target]);

  return tooltip;
}
