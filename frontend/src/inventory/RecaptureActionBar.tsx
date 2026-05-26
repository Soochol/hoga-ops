import type { RecaptureStatus } from './useInventoryRecapture';
import { RECAPTURABLE_DISK_STATES } from './DiskStateBadge';

export type { RecaptureStatus };

type Props = {
  recapturableCount: number;
  onRecaptureAll: () => void;
  status: RecaptureStatus | null;
  isPending: boolean;
};

/** Short tooltip derived from the DiskStateValue strings themselves —
 *  "source partial · client incomplete · invalid". Per the spec, this avoids
 *  the verbose PRESENTATION labels (which include em-dash explanations) and
 *  the hardcoded-string footgun. */
function recapturableTooltip(): string {
  return RECAPTURABLE_DISK_STATES.map((s) => s.replace(/_/g, ' ')).join(' · ');
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
          ↻ Re-capture all incomplete ({recapturableCount})
        </button>
      )}
      {status?.kind === 'success' && (
        <div className="text-fg-dim font-mono tabular-nums">
          Queued {status.enqueued} capture{status.enqueued === 1 ? '' : 's'}
          {status.skipped > 0 && ` (${status.skipped} skipped)`}
        </div>
      )}
      {status?.kind === 'error' && (
        <div role="alert" style={{ color: 'var(--error)' }}>
          {status.message}
        </div>
      )}
    </div>
  );
}
