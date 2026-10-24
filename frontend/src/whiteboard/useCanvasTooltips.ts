import { useEffect, useRef, useState, type RefObject } from 'react';
import { useTextTooltip } from '../ui/useTextTooltip';

type Hint = { element: HTMLElement; text: string };
const hintAttribute = 'data-canvas-tooltip';

/** Adapt Excalidraw's native titles and private hover labels to the app tooltip.
 * Keep this at the DOM boundary: the library has no tooltip renderer option.
 */
export function useCanvasTooltips(surface: RefObject<HTMLDivElement | null>) {
  const [hint, setHint] = useState<Hint | null>(null);
  const current = useRef<Hint | null>(null);
  const { tooltip, show, hide, id } = useTextTooltip(hint?.text ?? '', 500);
  useEffect(() => {
    if (!id || !hint) return;
    const element = hint.element;
    element.setAttribute('aria-describedby', [element.getAttribute('aria-describedby'), id].filter(Boolean).join(' '));
    return () => {
      const remaining = element.getAttribute('aria-describedby')?.split(/\s+/).filter(value => value !== id).join(' ');
      if (remaining) element.setAttribute('aria-describedby', remaining);
      else element.removeAttribute('aria-describedby');
    };
  }, [hint, id]);
  useEffect(() => { if (hint) show(hint.element); else hide(); }, [hint, show, hide]);

  useEffect(() => {
    const root = surface.current;
    if (!root) return;
    let mounted = true;
    let generation = 0;
    let vendorTooltip: HTMLElement | null = null;
    const adoptTitles = (node: Element) => {
      const elements = [...node.querySelectorAll<HTMLElement>('[title]')];
      if (node instanceof HTMLElement && node.hasAttribute('title')) elements.push(node);
      for (const element of elements) {
        const title = element.getAttribute('title') ?? '';
        if (title) {
          element.setAttribute(hintAttribute, title);
          if (!element.hasAttribute('aria-label') && !element.hasAttribute('aria-labelledby') && !element.textContent?.trim()) element.setAttribute('aria-label', title);
        }
        else element.removeAttribute(hintAttribute);
        element.removeAttribute('title');
      }
    };
    adoptTitles(root);
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes' && record.target instanceof Element && record.target.hasAttribute('title')) adoptTitles(record.target);
        for (const node of record.addedNodes) if (node instanceof Element) adoptTitles(node);
      }
      if (current.current && !current.current.element.isConnected) clear();
    });
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });
    const clear = () => {
      generation++;
      vendorTooltip?.classList.remove('excalidraw-tooltip--visible');
      vendorTooltip?.removeAttribute('data-canvas-tooltip-owned');
      vendorTooltip = null;
      current.current = null;
      setHint(null);
    };
    const select = (target: EventTarget | null, focus = false) => {
      if (!(target instanceof Element)) { clear(); return; }
      const wrapper = target.closest<HTMLElement>('.excalidraw-tooltip-wrapper');
      const titled = target.closest<HTMLElement>(`[${hintAttribute}]`);
      const anchor = wrapper ?? titled;
      const element = focus && anchor ? target.closest<HTMLElement>('button, input, [tabindex]') ?? anchor : anchor;
      if (!element || !root.contains(element) || element.closest('[aria-expanded="true"]')) { clear(); return; }
      // React's pointer-enter handler writes the private label after the native
      // event has bubbled through this surface. Read it before the next paint.
      const selected = ++generation;
      queueMicrotask(() => {
        if (!mounted || selected !== generation || !element.isConnected) return;
        const native = wrapper && !focus ? document.querySelector<HTMLElement>('.excalidraw-tooltip--visible') : null;
        const text = native?.textContent?.trim() || titled?.getAttribute(hintAttribute)
          || (focus ? target.getAttribute('aria-label') : '') || '';
        if (native) {
          vendorTooltip = native;
          native.setAttribute('data-canvas-tooltip-owned', '');
        }
        if (!text) { clear(); return; }
        if (current.current?.element === element && current.current.text === text) return;
        const next = { element, text };
        current.current = next;
        setHint(next);
      });
    };
    const over = (event: PointerEvent) => { if (event.buttons === 0 && event.pointerType !== 'touch') select(event.target); };
    const out = (event: PointerEvent) => {
      if (!(event.relatedTarget instanceof Node) || !current.current?.element.contains(event.relatedTarget)) clear();
    };
    const focus = (event: FocusEvent) => { if (event.target instanceof Element && event.target.matches(':focus-visible')) select(event.target, true); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') clear(); };
    root.addEventListener('pointerover', over);
    root.addEventListener('pointerout', out);
    root.addEventListener('focusin', focus);
    root.addEventListener('focusout', clear);
    root.addEventListener('pointerdown', clear);
    root.addEventListener('keydown', key);
    return () => {
      mounted = false;
      observer.disconnect();
      vendorTooltip?.removeAttribute('data-canvas-tooltip-owned');
      root.removeEventListener('pointerover', over);
      root.removeEventListener('pointerout', out);
      root.removeEventListener('focusin', focus);
      root.removeEventListener('focusout', clear);
      root.removeEventListener('pointerdown', clear);
      root.removeEventListener('keydown', key);
    };
  }, [surface]);
  return tooltip;
}
