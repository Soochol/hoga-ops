import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredPopover } from '../../util/useAnchoredPopover';

/** Shared title-bar settings button. Window actions stay visible at every width. */
export function WindowSettingsPopover({ title, buttonTitle, scope, width = 320, render, open: controlledOpen, onOpenChange, disabled = false }: {
  title: string;
  buttonTitle?: string;
  scope?: string;
  width?: number;
  render: (onClose: () => void) => ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const dialogId = useId();
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const wasOpen = useRef(false);
  const setOpen = useCallback((value: boolean) => {
    if (controlledOpen === undefined) setLocalOpen(value);
    onOpenChange?.(value);
  }, [controlledOpen, onOpenChange]);
  const close = useCallback(() => setOpen(false), [setOpen]);
  const { ref, style } = useAnchoredPopover(open, anchor, close, width);

  useLayoutEffect(() => {
    if (!open && wasOpen.current) anchor.current?.focus({ preventScroll: true });
    wasOpen.current = open;
  }, [open]);

  return <>
    <button ref={anchor} type="button" className="live-window-settings live-icon-button"
      aria-label={title} title={buttonTitle ?? title} aria-haspopup="dialog" aria-expanded={open}
      aria-controls={open ? dialogId : undefined}
      disabled={disabled} onPointerDown={event => event.stopPropagation()} onClick={() => setOpen(!open)}>
      <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9.5 3h5l.5 2 2 1 2-.5 2.5 4-1.5 1.5v2l1.5 1.5-2.5 4-2-.5-2 1-.5 2h-5l-.5-2-2-1-2 .5-2.5-4L4 13v-2L2.5 9.5l2.5-4 2 .5 2-1 .5-2Z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    </button>
    {open && createPortal(<div ref={ref} id={dialogId} style={style} role="dialog" aria-label={title}
      className="live-popover window-settings-popover" onPointerDown={event => event.stopPropagation()}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      }}>
      <header className="window-settings-heading">
        <h2>{title}</h2>
        {scope && <span>{scope}</span>}
        <button type="button" className="ui-icon-button" aria-label={`${title} 닫기`} onClick={close}>✕</button>
      </header>
      <div className="window-settings-content">{render(close)}</div>
    </div>, document.body)}
  </>;
}
