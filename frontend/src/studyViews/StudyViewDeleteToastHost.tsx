import { useEffect, useState } from 'react';
import { ToastCard } from '../ui/toast/ToastCard';
import { useStudyViewDeletion } from './studyViewDeletion';

type Batch = ReturnType<typeof useStudyViewDeletion.getState>['batches'][number];
function DeleteToast({ batch }: { batch: Batch }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (batch.phase !== 'pending') return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [batch.phase]);
  const { undo, dismiss, retry } = useStudyViewDeletion.getState();
  const label = batch.rows.length === 1 ? `‘${batch.rows[0].name}’` : `저장뷰 ${batch.rows.length}개`;
  const seconds = Math.max(0, Math.ceil((batch.deadline - now) / 1000));
  return <ToastCard visible role="status" ariaLabel="저장뷰 삭제 안내" variant={batch.failed.length ? 'error' : 'neutral'}
    action={batch.phase === 'pending' ? { label: '실행 취소', onClick: () => undo(batch.id) }
      : batch.phase === 'complete' ? { label: '닫기', onClick: () => dismiss(batch.id) } : undefined}>
    <div className="text-sm text-fg">{batch.phase === 'pending' ? `${label} 삭제 대기 · ${seconds}초 남음`
      : batch.phase === 'deleting' ? `${label} 삭제 중…`
        : `${batch.deleted}개 삭제 완료${batch.failed.length ? ` · ${batch.failed.length}개 삭제 실패` : ''}`}</div>
    {batch.failed.length > 0 && <div className="mt-1 text-xs text-fg-dim">
      <p>{batch.failed.map((r) => r.name).join(', ')}</p>
      <button type="button" className="text-accent" onClick={() => retry(batch.id)}>실패 항목 다시 시도</button>
    </div>}
  </ToastCard>;
}
export default function StudyViewDeleteToastHost() {
  const batches = useStudyViewDeletion((s) => s.batches);
  return <>{batches.map((batch) => <DeleteToast key={batch.id} batch={batch} />)}</>;
}
