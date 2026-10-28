import { useEffect, useState } from 'react';
import type { DesktopState } from '../../desktop';
import { SettingsRow } from './SettingsRow';

export default function DesktopSection() {
  const controls = window.hogaDesktop?.controls;
  const [state, setState] = useState<DesktopState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!controls) return;
    let disposed = false;
    const unsubscribe = controls.onZoomChange(zoomFactor => {
      if (!disposed) setState(current => current ? { ...current, zoomFactor } : current);
    });
    void controls.getState().then(value => { if (!disposed) setState(value); }, () => {
      if (!disposed) setError('데스크톱 연결 정보를 읽지 못했습니다.');
    });
    return () => { disposed = true; unsubscribe(); };
  }, [controls]);
  if (!controls) return null;
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await action(); } catch { setError('요청을 처리하지 못했습니다. 다시 시도하세요.'); }
    finally { setBusy(false); }
  };
  const zoom = (command: 'in' | 'out' | 'reset') => run(async () => {
    const zoomFactor = await controls.zoom(command);
    setState(current => current ? { ...current, zoomFactor } : current);
  });
  return <>
    <SettingsRow label="연결 서버" description={<>
      <span className="block">{state?.serverName ?? '연결 정보를 불러오는 중…'}</span>
      {state && <span className="block break-all">{state.origin}</span>}
      {state && state.apiOrigin !== state.origin && <span className="block break-all">API {state.apiOrigin}</span>}
    </>}>
      <button type="button" className="ui-choice" disabled={busy} onClick={() => void run(controls.selectServer)}>서버 선택</button>
    </SettingsRow>
    <p className="text-xs text-fg-dim">서버를 변경하면 기존 작업 창이 닫힙니다. 이미 접수된 주문·수집 작업은 기존 서버에서 계속됩니다.</p>
    <SettingsRow label="작업 창" description="현재 서버에 새 작업 창을 엽니다.">
      <button type="button" className="ui-choice" disabled={busy} onClick={() => void run(controls.newWindow)}>새 작업 창</button>
    </SettingsRow>
    <SettingsRow label="화면 배율" description="같은 서버의 작업 창에 함께 적용하고 기억합니다.">
      <div className="flex flex-wrap items-center gap-1">
        <button type="button" className="ui-choice" aria-label="화면 배율 축소" disabled={busy || !state || state.zoomFactor <= .5} onClick={() => void zoom('out')}>−</button>
        <output className="text-sm tabular-nums" aria-label="현재 화면 배율">{state ? `${Math.round(state.zoomFactor * 100)}%` : '—'}</output>
        <button type="button" className="ui-choice" aria-label="화면 배율 확대" disabled={busy || !state || state.zoomFactor >= 3} onClick={() => void zoom('in')}>+</button>
        <button type="button" className="ui-choice" disabled={busy || !state} onClick={() => void zoom('reset')}>100% 복원</button>
      </div>
    </SettingsRow>
    {error && <p role="alert" className="text-xs text-error">{error}</p>}
  </>;
}
