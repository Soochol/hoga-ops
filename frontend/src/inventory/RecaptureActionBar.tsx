import type { RecaptureStatus } from './useInventoryRecapture';
import { RECAPTURABLE_DISK_STATES, STATE_SHORT_LABEL } from './DiskStateBadge';

export type { RecaptureStatus };

type Props = {
  recapturableCount: number;
  onRecaptureAll: () => void;
  status: RecaptureStatus | null;
  isPending: boolean;
};

/** Short tooltip — "부분 · 미완결 · 손상". STATE_SHORT_LABEL 을 SSOT 로 참조해
 *  상태 추가 시 여기 하드코딩이 새로 생기지 않게 한다. */
function recapturableTooltip(): string {
  return RECAPTURABLE_DISK_STATES.map((s) => STATE_SHORT_LABEL[s]).join(' · ');
}

export function RecaptureActionBar({
  recapturableCount,
  onRecaptureAll,
  status,
  isPending,
}: Props) {
  if (recapturableCount === 0 && status === null) return null;

  return (
    <div className="flex flex-col gap-1 text-xs">
      {recapturableCount > 0 && (
        <button
          type="button"
          disabled={isPending}
          title={recapturableTooltip()}
          onClick={onRecaptureAll}
          className="rounded-md px-2.5 py-1 font-semibold cursor-pointer disabled:cursor-not-allowed border bg-bg-input border-accent text-accent hover:bg-accent hover:text-bg"
        >
          ↻ 미완결 전체 재캡처 ({recapturableCount})
        </button>
      )}
      {status?.kind === 'success' && (
        // role=status: 4초 뒤 자동 소멸하는 안내라 스크린리더 공지가 없으면 놓친다.
        <div role="status" className="text-fg-dim font-data tabular-nums">
          {status.enqueued}건 큐 등록
          {status.skipped > 0 && ` (${status.skipped}건 건너뜀)`}
        </div>
      )}
      {status?.kind === 'error' && (
        <div role="alert" className="text-error">
          {status.message}
        </div>
      )}
    </div>
  );
}
