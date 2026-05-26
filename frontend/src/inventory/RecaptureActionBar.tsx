import type { ReactNode } from 'react';

export type RecaptureStatus =
  | { kind: 'success'; enqueued: number; skipped: number }
  | { kind: 'error'; message: ReactNode };

type Props = {
  recapturableCount: number;
  selectedCount: number;
  onRecaptureSelected: () => void;
  onRecaptureAll: () => void;
  onClearSelection: () => void;
  status: RecaptureStatus | null;
  isPending: boolean;
};

export function RecaptureActionBar({
  recapturableCount,
  selectedCount,
  onRecaptureSelected,
  onRecaptureAll,
  onClearSelection,
  status,
  isPending,
}: Props) {
  if (recapturableCount === 0 && status === null) return null;

  const inSelectionMode = selectedCount > 0;

  return (
    <div className="flex flex-col gap-1 text-xs">
      <div className="flex items-center gap-3">
        {inSelectionMode ? (
          <>
            <span className="text-fg-dim font-mono tabular-nums">
              {selectedCount} selected
            </span>
            <button
              type="button"
              disabled={isPending}
              onClick={onRecaptureSelected}
              style={{
                background: isPending ? 'var(--bg-input)' : 'var(--accent)',
                color: isPending ? 'var(--fg-dimmer)' : 'var(--bg)',
              }}
              className="border-none rounded-md px-2.5 py-1 font-semibold cursor-pointer disabled:cursor-not-allowed"
            >
              ▶ Re-capture
            </button>
            <button
              type="button"
              onClick={onClearSelection}
              className="text-fg-dim hover:text-fg cursor-pointer bg-transparent border-none"
            >
              Clear
            </button>
          </>
        ) : recapturableCount > 0 ? (
          <button
            type="button"
            disabled={isPending}
            title="source partial · client incomplete · invalid"
            onClick={onRecaptureAll}
            className="text-fg-dim hover:text-fg cursor-pointer bg-transparent border-none disabled:cursor-not-allowed"
          >
            Re-capture all incomplete ({recapturableCount})
          </button>
        ) : null}
      </div>
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
