import { useEffect, useState, type ReactNode } from 'react';
import { getConfig } from '../api/client';
import { ToolbarButton } from './PageShell';

function StrictConfigGate({ children }: { children: ReactNode }) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ ready: boolean; error?: string }>({ ready: false });
  useEffect(() => {
    let cancelled = false;
    void getConfig().then(() => { if (!cancelled) setState({ ready: true }); }, error => {
      if (!cancelled) setState({ ready: false, error: error instanceof Error ? error.message : '설정을 읽지 못했습니다.' });
    });
    return () => { cancelled = true; };
  }, [attempt]);
  if (state.ready) return children;
  return <div className="grid place-items-center min-h-screen bg-bg text-fg p-6">
    <div className="max-w-xl space-y-4" role="status">
      <p>{state.error ?? '서버 연결 설정을 확인하고 있습니다…'}</p>
      {state.error && <><p className="text-sm text-fg-dim">다른 서버는 서버 선택 화면에서 연결할 수 있습니다. 단축키: Ctrl+Alt+S</p>
        {window.hogaDesktop?.controls && <ToolbarButton onClick={() => {
          void window.hogaDesktop!.controls!.selectServer().catch(() => setState({ ready: false, error: '서버 선택 화면을 열지 못했습니다. Ctrl+Alt+S를 사용하세요.' }));
        }}>서버 선택</ToolbarButton>}
        <ToolbarButton onClick={() => { setState({ ready: false }); setAttempt(value => value + 1); }}>다시 시도</ToolbarButton></>}
    </div>
  </div>;
}

export default function DesktopConfigGate({ children }: { children: ReactNode }) {
  return window.hogaDesktop?.strictConfig ? <StrictConfigGate>{children}</StrictConfigGate> : children;
}
