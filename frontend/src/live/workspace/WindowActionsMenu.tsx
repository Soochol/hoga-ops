import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredPopover } from '../../util/useAnchoredPopover';

/** Keeps window actions reachable when the title bar folds at narrow widths. */
export function WindowActionsMenu({ maximized, alwaysOnTop, pinned, canPin, onMaximize, onAlwaysOnTop, onPin, settings, compact = true }: {
  maximized: boolean;
  alwaysOnTop: boolean;
  pinned: boolean;
  canPin: boolean;
  onMaximize?: () => void;
  onAlwaysOnTop?: () => void;
  onPin?: () => void;
  settings?: { title: string; render: (onClose: () => void) => ReactNode };
  compact?: boolean;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [surface, setSurface] = useState<'actions' | 'settings' | null>(null);
  const previousSurface = useRef(surface);
  const close = useCallback(() => setSurface(null), []);
  const { ref, style } = useAnchoredPopover(surface !== null, anchor, close, surface === 'settings' ? 320 : 208);
  useLayoutEffect(() => {
    if (surface === 'settings') {
      const target = ref.current?.querySelector<HTMLElement>('[aria-pressed="true"]')
        ?? ref.current?.querySelector<HTMLElement>('button, input');
      target?.focus({ preventScroll: true });
    }
    if (surface === null && previousSurface.current !== null) anchor.current?.focus({ preventScroll: true });
    previousSurface.current = surface;
  }, [surface, ref]);
  const act = (action: () => void) => { action(); close(); };
  const settingsOnly = settings !== undefined && !compact;
  const label = settingsOnly ? settings.title : '창 옵션';
  const openSurface = settingsOnly ? 'settings' : 'actions';
  return <>
    <button ref={anchor} type="button" className="live-window-actions-menu live-icon-button"
      data-has-settings={settings ? '' : undefined}
      aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={surface !== null}
      onPointerDown={event => event.stopPropagation()}
      onClick={() => setSurface(value => value === null ? openSurface : null)}>
      {settingsOnly ? <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9.5 3h5l.5 2 2 1 2-.5 2.5 4-1.5 1.5v2l1.5 1.5-2.5 4-2-.5-2 1-.5 2h-5l-.5-2-2-1-2 .5-2.5-4L4 13v-2L2.5 9.5l2.5-4 2 .5 2-1 .5-2Z" />
        <circle cx="12" cy="12" r="3" />
      </svg> : <svg aria-hidden width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" />
      </svg>}
    </button>
    {surface !== null && createPortal(<div ref={ref} style={style} role="dialog" aria-label={surface === 'settings' ? settings?.title : '창 옵션'}
      className="live-popover max-h-[calc(100vh-8px)] overflow-y-auto p-1" onPointerDown={event => event.stopPropagation()}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      }}>
      {surface === 'settings' && settings ? <>
        <div className="flex items-center justify-between gap-2 px-3 pt-2">
          <h2 className="font-medium">{settings.title}</h2>
          <button type="button" className="ui-icon-button" aria-label={`${settings.title} 닫기`} onClick={close}>✕</button>
        </div>
        {settings.render(close)}
      </> : <>
        {onMaximize && <button type="button" className="live-menu-item" onClick={() => act(onMaximize)}>
          {maximized ? '원래 크기로 복원' : '창 최대화'}
        </button>}
        {onAlwaysOnTop && <button type="button" className="live-menu-item" aria-pressed={alwaysOnTop}
          onClick={() => act(onAlwaysOnTop)}><span>항상 위</span><span aria-hidden>{alwaysOnTop ? '✓' : ''}</span></button>}
        {onPin && <button type="button" className="live-menu-item" aria-pressed={pinned} disabled={!canPin}
          title={canPin ? '목록에서 다른 종목을 선택해도 이 창의 종목을 유지합니다' : '고정할 종목이 없습니다'}
          onClick={() => act(onPin)}><span>종목 고정</span><span aria-hidden>{pinned ? '✓' : ''}</span></button>}
        {settings && <button type="button" className="live-menu-item" onClick={() => setSurface('settings')}>설정</button>}
      </>}
    </div>, document.body)}
  </>;
}
