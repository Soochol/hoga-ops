import { AppIcon } from '../ui/AppIcon';
import { lazy, Suspense, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { IconToolbarButton } from '../ui/WorkspaceShell';
import { DEFAULT_TOAST_DURATION_MS, useToastTimer } from '../ui/toast/useToastTimer';
import { ToastCard } from '../ui/toast/ToastCard';
import { ToastViewport } from '../ui/toast/ToastViewport';
import { captureChartImage, chartImageFilename, downloadChartImage } from './chartImage';

type Notice = { message: string; error?: boolean; fallback?: { blob: Blob; filename: string } };
const ChartToBoardDialog = lazy(() => import('../whiteboard/ChartToBoardDialog'));

/** Keep export state out of the live chart's render path. */
export function ChartCaptureActions({ viewportRef, code, timeframe, available }: {
  viewportRef: RefObject<HTMLDivElement | null>;
  code: string | null;
  timeframe: string;
  available: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [boardOpen, setBoardOpen] = useState(false);
  const busyRef = useRef(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [toastHost] = useState(() => document.getElementById('toast-viewport'));
  const canCopy = typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function';

  const timer = useToastTimer({ visible: notice != null, resetKey: notice,
    durationMs: busy ? null : notice?.error ? 10000 : DEFAULT_TOAST_DURATION_MS, onExpire: () => setNotice(null) });

  async function exportImage(action: 'copy' | 'save') {
    const viewport = viewportRef.current;
    if (!viewport || !code || !available || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
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

  const toast = notice && (
    <ToastCard visible role={notice.error ? 'alert' : 'status'} variant={notice.error ? 'error' : 'neutral'}
      title={notice.message} onDismiss={busy ? undefined : () => setNotice(null)} dismissLabel="차트 캡처 알림 닫기"
      progress={timer.progress} {...timer.interactionProps}
      action={notice.fallback ? { label: 'PNG로 저장', onClick: () => {
        const fallback = notice.fallback!;
        downloadChartImage(fallback.blob, fallback.filename);
        setNotice({ message: '차트 PNG를 저장했습니다' });
      } } : undefined} />
  );
  const captureHint = !available ? '차트를 불러온 후 캡처할 수 있습니다' : busy ? '차트 이미지를 만드는 중…'
    : '현재 보이는 차트와 보조지표를 캡처합니다';
  return <>
    <IconToolbarButton aria-label="복기 노트에 추가" title={`복기 노트에 추가 — ${captureHint}`}
      disabled={!available || busy || !code} onClick={() => setBoardOpen(true)}
      icon={<AppIcon name="board" />} />
    {boardOpen && code && <Suspense fallback={null}><ChartToBoardDialog code={code} timeframe={timeframe} onClose={() => setBoardOpen(false)} capture={() => {
      const viewport = viewportRef.current;
      if (!viewport || !available) return Promise.reject(new Error('차트를 불러온 후 추가해 주세요'));
      return captureChartImage(viewport);
    }} /></Suspense>}
    <IconToolbarButton aria-label="차트 이미지 복사" aria-busy={busy}
      title={`차트 이미지 복사 — ${canCopy ? captureHint : '이미지 복사를 지원하지 않아 PNG로 저장해 주세요'}`}
      disabled={!available || busy || !canCopy} onClick={() => void exportImage('copy')}
      icon={<AppIcon name="copy" />} />
    <IconToolbarButton aria-label="PNG로 저장" aria-busy={busy} title={`PNG로 저장 — ${captureHint}`}
      disabled={!available || busy} onClick={() => void exportImage('save')}
      icon={<AppIcon name="imageDownload" />} />
    {toast && createPortal(toastHost ? toast : <ToastViewport>{toast}</ToastViewport>, toastHost ?? document.body)}
  </>;
}
