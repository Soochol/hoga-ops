import { useState } from 'react';
import type { ParquetStudyViewWriteRequest } from '../api/studyViews';
import { buildLiveStudySaveRequest, studySnapshotByteSize } from './studySaveRequest';
import { useCurrentStudySaveSource } from './studySaveSource';
import { StudyViewSaveDialog } from './StudyViewSaveDialog';
import { useStudyViewMutations } from './useStudyViews';

export function LiveStudyViewSaveButton() {
  const saveSource = useCurrentStudySaveSource();
  const mutations = useStudyViewMutations();
  const [request, setRequest] = useState<ParquetStudyViewWriteRequest | null>(null);
  const liveSource = saveSource?.origin === 'live' ? saveSource : null;

  const openDialog = () => {
    if (!liveSource) return;
    const nextRequest = buildLiveStudySaveRequest(liveSource);
    if (nextRequest) setRequest(nextRequest);
  };

  return (
    <>
      <button
        type="button"
        disabled={!liveSource}
        onClick={openDialog}
        className="inline-flex items-center gap-1 px-2 py-1 rounded hover:opacity-90 transition-opacity disabled:opacity-50"
        style={{
          background: 'var(--bg-input)',
          color: 'var(--fg-dim)',
          border: '1px solid var(--border)',
          fontSize: 'var(--text-xs)',
        }}
      >
        현재 뷰 저장
      </button>
      {request && (
        <StudyViewSaveDialog
          mode="create"
          defaultName={request.name}
          defaultMemo={request.memo ?? ''}
          barCount={request.snapshot.bundle.candles.length}
          sizeBytes={studySnapshotByteSize(request.snapshot)}
          onCancel={() => setRequest(null)}
          onSubmit={({ name, memo }) => {
            mutations.create.mutate(
              { ...request, name, memo },
              { onSuccess: () => setRequest(null) },
            );
          }}
        />
      )}
    </>
  );
}
