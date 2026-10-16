import { useState } from 'react';
import { useLiveStatus } from '../api/liveStatus';
import { serviceIssues } from '../serviceStatus/model';
import { useServiceStatusPanel } from '../serviceStatus/controls';
import { ToastAction, ToastCard } from '../ui/toast/ToastCard';
import { useToastTimer } from '../ui/toast/useToastTimer';
import { requestSettingsModal } from './settingsModalControls';

/** Attention on a new incident; the status panel owns the persistent observation. */
export default function LiveOperationalToastHost() {
  const { data, isError } = useLiveStatus();
  const issues = serviceIssues(data).filter(issue => issue.source === 'collector' || issue.source === 'capture' || issue.source === 'auth'
    || (issue.source === 'provider' && issue.channel === 'rest' && issue.kind === 'auth'));
  const key = issues.map(issue => `${issue.id}:${issue.title}:${issue.cause}`).sort().join('|');
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [shown, setShown] = useState({ key, issues });
  if (issues.length && key !== shown.key) setShown({ key, issues });
  if (!key && !isError && dismissedKey !== null) setDismissedKey(null);
  const visible = issues.length > 0 && dismissedKey !== key;
  const dismiss = () => setDismissedKey(key);
  const timer = useToastTimer({ visible, resetKey: key, durationMs: 10000, onExpire: dismiss });
  const payload = issues.length ? issues : shown.issues;
  return <ToastCard visible={visible} role="status" ariaLabel="실시간 서비스 알림"
    variant={payload.some(issue => issue.tone === 'error') ? 'error' : 'warn'}
    title={payload.length === 1 ? payload[0].title : '실시간 서비스 확인 필요'} onDismiss={dismiss}
    progress={timer.progress} {...timer.interactionProps}
    actions={<>
      <ToastAction onClick={() => useServiceStatusPanel.getState().show()}>서비스 상태 보기</ToastAction>
      <ToastAction onClick={requestSettingsModal}>설정</ToastAction>
    </>}>
    {payload.slice(0, 2).map(issue => <p key={issue.id}>{payload.length > 1 ? `${issue.title} · ` : ''}{issue.cause}</p>)}
    {payload.length > 2 && <p>외 {payload.length - 2}건</p>}
  </ToastCard>;
}
