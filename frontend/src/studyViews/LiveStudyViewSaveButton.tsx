import { useState } from 'react';
import { studySnapshotByteSize } from './studySaveRequest';
import { makeStudySaveCommand, type StudySaveCommand } from './studySaveCommand';
import { useCurrentStudySaveSource } from './studySaveSource';
import { StudyViewSaveDialog } from './StudyViewSaveDialog';
import { useStudyViewMutations } from './useStudyViews';

export function LiveStudyViewSaveButton() {
  const saveSource = useCurrentStudySaveSource();
  const mutations = useStudyViewMutations();
  const [command, setCommand] = useState<StudySaveCommand | null>(null);
  const liveSource = saveSource?.origin === 'live' ? saveSource : null;
  const createError = mutations.create.error instanceof Error ? mutations.create.error.message : null;

  const openDialog = () => {
    if (!liveSource) return;
    const nextCommand = makeStudySaveCommand({ mode: 'create', source: liveSource, existingSave: null });
    if (nextCommand) setCommand(nextCommand);
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
      {command && (
        <StudyViewSaveDialog
          mode="create"
          defaultName={command.defaultName}
          defaultMemo={command.defaultMemo}
          barCount={command.request.snapshot.bundle.candles.length}
          sizeBytes={studySnapshotByteSize(command.request.snapshot)}
          isSubmitting={mutations.create.isPending}
          errorMessage={createError}
          onCancel={() => setCommand(null)}
          onSubmit={({ name, memo }) => {
            mutations.create.mutate(
              { ...command.request, name, memo },
              { onSuccess: () => setCommand(null) },
            );
          }}
        />
      )}
    </>
  );
}
