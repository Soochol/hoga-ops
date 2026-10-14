import { useCallback, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredPopover } from '../util/useAnchoredPopover';
import './dataControls.css';

export function DataControlPopover({ label, children }: { label: string; children: ReactNode }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const id = useId();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => {
    setOpen(false);
    anchor.current?.focus({ preventScroll: true });
  }, []);
  const { ref, style } = useAnchoredPopover(open, anchor, close, 300);
  return <>
    <button ref={anchor} type="button" className="ui-choice" aria-label={label} aria-haspopup="dialog"
      aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}>
      {label}<span aria-hidden> ▾</span>
    </button>
    {open && createPortal(<div ref={ref} id={id} role="dialog" aria-label={label}
      className="ui-popover data-settings-popover" style={style}>
      <div className="flex items-center justify-between gap-2 border-b border-border pb-1">
        <span className="font-medium">{label}</span>
        <button type="button" className="ui-icon-button" aria-label={`${label} 닫기`} onClick={close}>×</button>
      </div>
      <div className="data-settings-content">{children}</div>
    </div>, document.body)}
  </>;
}

/** Keep the primary controls visible; move secondary controls outside narrow windows. */
export function ResponsiveDataControls({ children, secondary, status, label = '표시 설정' }: {
  children: ReactNode; secondary: ReactNode; status?: ReactNode; label?: string;
}) {
  return <>
    <div className="responsive-data-controls live-data-controls">
      <div className="responsive-data-primary">{children}</div>
      <div className="responsive-data-secondary">{secondary}</div>
      <div className="responsive-data-more"><DataControlPopover label={label}>{secondary}</DataControlPopover></div>
    </div>
    {status && <div role="status" className="responsive-data-status">{status}</div>}
  </>;
}
