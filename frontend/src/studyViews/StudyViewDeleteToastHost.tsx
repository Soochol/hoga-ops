import { useEffect, useRef, useState } from 'react';
import { ToastAction, ToastCard } from '../ui/toast/ToastCard';
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
    title={batch.phase === 'pending' ? `${label} 삭제 대기 · ${seconds}초 남음`
      : batch.phase === 'deleting' ? `${label} 삭제 중…`
        : `${batch.deleted}개 삭제 완료${batch.failed.length ? ` · ${batch.failed.length}개 삭제 실패` : ''}`}
    action={batch.phase === 'pending' ? { label: '실행 취소', onClick: () => undo(batch.id) } : undefined}
    onDismiss={batch.phase === 'complete' ? () => dismiss(batch.id) : undefined}
    actions={batch.failed.length > 0 && <ToastAction emphasis="accent" onClick={() => retry(batch.id)}>실패 항목 다시 시도</ToastAction>}>
    {batch.failed.length > 0 ? <p>{batch.failed.map((r) => r.name).join(', ')}</p> : null}
  </ToastCard>;
}
export default function StudyViewDeleteToastHost() {
  const batches = useStudyViewDeletion((s) => s.batches);
  const listRef = useRef<HTMLDivElement>(null);
  const newestId = batches.at(-1)?.id;
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [newestId]);
  if (!batches.length) return null;
  // A held Delete key can enqueue many independent undo windows. Keep every
  // action reachable without pushing later requests above the viewport.
  return <div ref={listRef} role="region" aria-label="저장뷰 삭제 알림 목록"
    className="pointer-events-auto flex max-h-[50vh] flex-col gap-2 overflow-y-auto">
    {[...batches].reverse().map((batch) => <div key={batch.id} className="shrink-0"><DeleteToast batch={batch} /></div>)}
  </div>;
}
