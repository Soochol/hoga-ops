/**
 * 「현재 뷰 저장」 — 차트 창 헤더 소유.
 *
 * 이전에는 전역 툴바에 있으면서 `useCurrentStudySaveSource()` 로 전역 1슬롯을
 * 읽었고, 그 슬롯은 **z-최상위 차트 창**이 채웠다(targetChartWindow 추론).
 * 버튼이 창 헤더로 내려오면서 그 추론이 불필요해졌다 — 창이 자기 소스를
 * 직접 넘긴다(#759 가 보조지표에 대해 한 것과 같은 단순화).
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { makeStudySaveCommand, studySaveCommandBody, type StudySaveCommand } from './studySaveCommand';
import type { LiveStudySaveSource } from './studySaveCommand';
import { StudyViewSaveDialog, type SaveCoverage } from './StudyViewSaveDialog';
import { useStudyViewMutations } from './useStudyViews';
import { bulkItems, coveragePreview } from '../api/captures';
import { CAPTURE_QUEUE_QUERY_KEY } from '../capture/useCaptureQueue';
import { COMPACT_PADDING_INLINE } from '../live/workspace/chartHeaderCompact';

export function LiveStudyViewSaveButton({
  source,
  showLabel = true,
}: {
  /** 이 창의 저장 소스. 아직 준비 안 됐으면(번들 미도착·미지원 종목) null. */
  source: LiveStudySaveSource | null;
  /** false 면 아이콘만 — 헤더가 좁을 때 라벨을 접는다(#762 접힘 정책). */
  showLabel?: boolean;
}) {
  const mutations = useStudyViewMutations();
  const queryClient = useQueryClient();
  const [command, setCommand] = useState<StudySaveCommand | null>(null);
  const createError = mutations.create.error instanceof Error ? mutations.create.error.message : null;

  // 저장 구간의 hogaplay 커버리지. 다이얼로그가 열려 있는 동안만 조회한다.
  // coverage-preview 는 읽기 전용이라 적재를 유발하지 않는다.
  const range = command?.request.range;
  const previewQuery = useQuery({
    queryKey: ['study-save-coverage', command?.request.code, range?.from_date, range?.to_date],
    queryFn: () => coveragePreview({
      codes: [command!.request.code],
      start_date: range!.from_date,
      end_date: range!.to_date,
    }),
    enabled: !!command && !!range,
    staleTime: 30_000,
    retry: false,
  });

  // 수집은 저장의 곁가지 — 실패해도 저장을 되돌리지 않는다. 다만 조용히 삼키지는
  // 않고 큐를 무효화해 캡처 패널이 실제 상태를 드러내게 한다.
  const collect = useMutation({
    mutationFn: bulkItems,
    onSettled: () => queryClient.invalidateQueries({ queryKey: CAPTURE_QUEUE_QUERY_KEY }),
  });

  const coverage: SaveCoverage | null = command
    ? {
      isLoading: previewQuery.isLoading,
      isError: previewQuery.isError,
      have: previewQuery.data?.have ?? 0,
      toCollect: previewQuery.data?.to_collect ?? 0,
      estMinutes: previewQuery.data?.est_minutes ?? 0,
    }
    : null;

  const openDialog = () => {
    if (!source) return;
    const nextCommand = makeStudySaveCommand({ mode: 'create', source, existingSave: null });
    if (nextCommand) setCommand(nextCommand);
  };

  return (
    <>
      <button
        type="button"
        data-testid="live-study-save-button"
        disabled={!source}
        onClick={openDialog}
        aria-label="현재 뷰 저장"
        title="현재 뷰 저장"
        className="inline-flex min-h-6 shrink-0 items-center gap-1 rounded-[7px] px-2 py-1 text-xs text-fg-dim transition-colors hover:bg-bg-input-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
        style={{ background: 'transparent', paddingInline: showLabel ? undefined : COMPACT_PADDING_INLINE }}
      >
        <span aria-hidden="true" className="font-data">▤</span>
        {showLabel && <span>저장</span>}
      </button>
      {command && (
        <StudyViewSaveDialog
          mode="create"
          defaultName={command.dialog.defaultName}
          defaultMemo={command.dialog.defaultMemo}
          rangeLabel={command.dialog.rangeLabel}
          coverage={coverage}
          isSubmitting={mutations.create.isPending}
          errorMessage={createError}
          onCancel={() => setCommand(null)}
          onSubmit={({ name, memo, capture }) => {
            const missing = previewQuery.data?.missing ?? [];
            mutations.create.mutate(
              studySaveCommandBody(command, { name, memo }),
              {
                onSuccess: () => {
                  if (capture && missing.length > 0) collect.mutate(missing);
                  setCommand(null);
                },
              },
            );
          }}
        />
      )}
    </>
  );
}
