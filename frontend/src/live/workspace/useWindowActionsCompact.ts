import { useLayoutEffect, useState } from 'react';

/** Reserve a readable title and measure the full action group, even while folded. */
export function useWindowActionsCompact(hasSettings: boolean) {
  const [actions, setActions] = useState<HTMLDivElement | null>(null);
  const [compact, setCompact] = useState(false);

  useLayoutEffect(() => {
    const header = actions?.parentElement;
    if (!actions || !header) return;

    const measure = () => {
      if (!header.clientWidth) return;
      const style = getComputedStyle(header);
      const available = header.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const children = Array.from(header.children).filter((child): child is HTMLElement => {
        if (!(child instanceof HTMLElement)) return false;
        if (child.classList.contains('live-window-actions-menu')) return hasSettings;
        return child === actions || getComputedStyle(child).display !== 'none';
      });
      const required = children.reduce((width, child) => {
        const childStyle = getComputedStyle(child);
        const titleReserve = parseFloat(childStyle.flexBasis);
        // Flexible titles give up their extra space before any action is folded.
        return width + (parseFloat(childStyle.flexGrow) > 0 && Number.isFinite(titleReserve)
          ? titleReserve
          : child.getBoundingClientRect().width);
      }, 0) + (parseFloat(style.columnGap) || 0) * Math.max(0, children.length - 1);
      setCompact(required > available);
    };

    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    for (const child of header.children) observer.observe(child);
    return () => observer.disconnect();
  }, [actions, hasSettings]);

  return { actionsRef: setActions, compact };
}
