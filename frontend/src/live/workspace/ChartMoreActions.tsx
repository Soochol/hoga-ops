import { useCallback, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconToolbarButton } from '../../ui/WorkspaceShell';
import { useAnchoredPopover } from '../../util/useAnchoredPopover';

/** Keep children mounted: a save dialog must survive dismissal of its launcher. */
export function ChartMoreActions({ children, compact = false }: { children: ReactNode; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const { ref, style } = useAnchoredPopover(open, anchor, close, 256);
  return <>
    <IconToolbarButton ref={anchor} aria-label="차트 더보기" aria-expanded={open} aria-haspopup="dialog"
      onClick={() => setOpen((value) => !value)}
      icon={<span aria-hidden className="text-base leading-none">···</span>}>
      {!compact && '더보기'}
    </IconToolbarButton>
    {createPortal(
      <div ref={ref} role="dialog" aria-label="차트 추가 기능" hidden={!open}
        className="chart-more-actions rounded-lg border border-border bg-bg-card p-sm shadow-overlay"
        style={style}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.stopPropagation(); close(); anchor.current?.focus(); }
        }}>
        {children}
      </div>, document.body,
    )}
  </>;
}
