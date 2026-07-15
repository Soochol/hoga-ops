import { useState } from 'react';
import { makeStudySaveCommand, studySaveCommandBody, type StudySaveCommand } from './studySaveCommand';
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
        className="inline-flex items-center gap-1 rounded px-2 py-1 text-fg-dim transition-colors hover:bg-bg-input-hover hover:text-fg disabled:opacity-50"
        style={{
          // 테두리 없는 ghost(2026-07-15) — 투명 배경 + hover 시 배경.
          background: 'transparent',
          fontSize: 'var(--text-xs)',
        }}
      >
        현재 뷰 저장
      </button>
      {command && (
        <StudyViewSaveDialog
          mode="create"
          defaultName={command.dialog.defaultName}
          defaultMemo={command.dialog.defaultMemo}
          rangeLabel={command.dialog.rangeLabel}
          isSubmitting={mutations.create.isPending}
          errorMessage={createError}
          onCancel={() => setCommand(null)}
          onSubmit={({ name, memo }) => {
            mutations.create.mutate(
              studySaveCommandBody(command, { name, memo }),
              { onSuccess: () => setCommand(null) },
            );
          }}
        />
      )}
    </>
  );
}
