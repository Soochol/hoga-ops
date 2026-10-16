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
      {state.error && <><p className="text-sm text-fg-dim">다른 서버를 선택하려면 Ctrl+Alt+S 또는 화면 우클릭의 서버 선택을 사용하세요.</p>
        <ToolbarButton onClick={() => { setState({ ready: false }); setAttempt(value => value + 1); }}>다시 시도</ToolbarButton></>}
    </div>
  </div>;
}

export default function DesktopConfigGate({ children }: { children: ReactNode }) {
  return window.hogaDesktop?.strictConfig ? <StrictConfigGate>{children}</StrictConfigGate> : children;
}
