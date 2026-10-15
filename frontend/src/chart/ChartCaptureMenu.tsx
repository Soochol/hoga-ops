import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { IconToolbarButton } from '../ui/WorkspaceShell';
import { useAnchoredPopover } from '../util/useAnchoredPopover';
import { ToastCard } from '../ui/toast/ToastCard';
import { ToastViewport } from '../ui/toast/ToastViewport';
import { captureChartImage, chartImageFilename, downloadChartImage } from './chartImage';

type Notice = { message: string; error?: boolean; fallback?: { blob: Blob; filename: string } };
const itemClass = 'block w-full px-3 py-2 text-left text-sm text-fg enabled:hover:bg-bg-input-hover focus:bg-bg-input-hover disabled:cursor-default disabled:opacity-40';

/** Keep menu/export state out of the live chart's render path. */
export function ChartCaptureMenu({ viewportRef, code, timeframe, available }: {
  viewportRef: RefObject<HTMLDivElement | null>;
  code: string | null;
  timeframe: string;
  available: boolean;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [toastHost] = useState(() => document.getElementById('toast-viewport'));
  const close = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus({ preventScroll: true });
  }, []);
  const { ref: menuRef, style: menuStyle } = useAnchoredPopover(open, buttonRef, close, 240);
  const canCopy = typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function';

  useLayoutEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
  }, [open, menuRef]);

  useEffect(() => {
    if (!notice || busy) return;
    const timer = window.setTimeout(() => setNotice(null), notice.error ? 10000 : 3500);
    return () => window.clearTimeout(timer);
  }, [notice, busy]);

  async function exportImage(action: 'copy' | 'save') {
    const viewport = viewportRef.current;
    if (!viewport || !code || !available || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    close();
    setNotice({ message: '차트 이미지를 만드는 중…' });
    const filename = chartImageFilename(code, timeframe);
    const image = captureChartImage(viewport);
    try {
      if (action === 'copy') {
        // Write during user activation, passing the asynchronously rendered PNG
        // as a promise (also supported by browsers with strict activation).
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': image })]);
        setNotice({ message: '차트 이미지를 복사했습니다' });
      } else {
        downloadChartImage(await image, filename);
        setNotice({ message: '차트 PNG를 저장했습니다' });
      }
    } catch {
      let blob: Blob | undefined;
      try { blob = await image; } catch { /* Capture itself failed. */ }
      setNotice(blob && action === 'copy'
        ? { message: '이미지를 복사하지 못했습니다. PNG로 저장해 주세요.', error: true, fallback: { blob, filename } }
        : { message: '차트를 캡처하지 못했습니다. 다시 시도해 주세요.', error: true });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  }

  const toast = notice && (
    <ToastCard visible role={notice.error ? 'alert' : 'status'} variant={notice.error ? 'error' : 'neutral'}
      action={notice.fallback ? { label: 'PNG로 저장', onClick: () => {
        const fallback = notice.fallback!;
        downloadChartImage(fallback.blob, fallback.filename);
        setNotice({ message: '차트 PNG를 저장했습니다' });
      } } : undefined}>
      <div className="flex items-start justify-between gap-3 text-sm text-fg">
        <span>{notice.message}</span>
        {!busy && <button type="button" aria-label="차트 캡처 알림 닫기" onClick={() => setNotice(null)} className="text-fg-dim hover:text-fg">✕</button>}
      </div>
    </ToastCard>
  );
  return <>
    <IconToolbarButton ref={buttonRef} aria-label="차트 메뉴" title="차트 메뉴" aria-haspopup="menu"
      aria-expanded={open} aria-controls={open ? menuId : undefined}
      onClick={() => setOpen(value => !value)}
      onKeyDown={event => {
        if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); }
      }}
      icon={<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
        <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
      </svg>}>
      <span className="live-action-label">메뉴</span>
    </IconToolbarButton>
    {open && createPortal(<div ref={menuRef} id={menuId} role="menu" aria-label="캔들 차트" style={menuStyle}
      onPointerDown={event => event.stopPropagation()}
      className="max-h-[calc(100vh-16px)] overflow-y-auto rounded-lg border border-border bg-bg-card py-1 shadow-overlay">
      <div onKeyDown={navigate}>
        <button type="button" role="menuitem" className={itemClass} disabled={!available || busy || !canCopy} onClick={() => void exportImage('copy')}>
          차트 이미지 복사
        </button>
        <button type="button" role="menuitem" className={itemClass} disabled={!available || busy} onClick={() => void exportImage('save')}>
          PNG로 저장
        </button>
      </div>
      <div className="border-t border-border px-3 py-2 text-xs text-fg-dim">
        {!available ? '차트를 불러온 후 캡처할 수 있습니다' : busy ? '차트 이미지를 만드는 중…'
          : !canCopy ? '이미지 복사를 지원하지 않아 PNG로 저장해 주세요' : '현재 보이는 차트와 보조지표를 캡처합니다'}
      </div>
    </div>, document.body)}
    {toast && createPortal(toastHost ? toast : <ToastViewport>{toast}</ToastViewport>, toastHost ?? document.body)}
  </>;
}
