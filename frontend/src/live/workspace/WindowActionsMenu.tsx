import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredPopover } from '../../util/useAnchoredPopover';

/** Keeps window actions reachable when the title bar folds at narrow widths. */
export function WindowActionsMenu({ maximized, alwaysOnTop, pinned, canPin, onMaximize, onAlwaysOnTop, onPin }: {
  maximized: boolean;
  alwaysOnTop: boolean;
  pinned: boolean;
  canPin: boolean;
  onMaximize?: () => void;
  onAlwaysOnTop?: () => void;
  onPin?: () => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => {
    setOpen(false);
    anchor.current?.focus({ preventScroll: true });
  }, []);
  const { ref, style } = useAnchoredPopover(open, anchor, close, 208);
  const act = (action: () => void) => { action(); close(); };
  return <>
    <button ref={anchor} type="button" className="live-window-actions-menu live-icon-button"
      aria-label="창 옵션" title="창 옵션" aria-haspopup="dialog" aria-expanded={open}
      onPointerDown={event => event.stopPropagation()} onClick={() => setOpen(value => !value)}>
      <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" />
      </svg>
    </button>
    {open && createPortal(<div ref={ref} style={style} role="dialog" aria-label="창 옵션"
      className="live-popover p-1" onPointerDown={event => event.stopPropagation()}>
      {onMaximize && <button type="button" className="live-menu-item" onClick={() => act(onMaximize)}>
        {maximized ? '원래 크기로 복원' : '창 최대화'}
      </button>}
      {onAlwaysOnTop && <button type="button" className="live-menu-item" aria-pressed={alwaysOnTop}
        onClick={() => act(onAlwaysOnTop)}><span>항상 위</span><span aria-hidden>{alwaysOnTop ? '✓' : ''}</span></button>}
      {onPin && <button type="button" className="live-menu-item" aria-pressed={pinned} disabled={!canPin}
        title={canPin ? '목록에서 다른 종목을 선택해도 이 창의 종목을 유지합니다' : '고정할 종목이 없습니다'}
        onClick={() => act(onPin)}><span>종목 고정</span><span aria-hidden>{pinned ? '✓' : ''}</span></button>}
    </div>, document.body)}
  </>;
}
