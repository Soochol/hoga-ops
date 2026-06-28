import { useMemo, useRef, useState } from 'react';
import { useMutationState } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ADD_ITEMS_MUTATION_KEY, useCaptureQueue } from './useCaptureQueue';
import { useSymbols } from './useSymbols';
import { CaptureQueueRow } from './CaptureQueueRow';
import { GROUP_ORDER, getPhase } from './phase';
import { useStockDates } from '../api/stock-dates';
import type { EnqueueDedupedRow, EnqueueResponse, QueueItem, QueueSnapshot } from '../api/types';
import { EmptyState, InlineState } from '../ui/DataSurface';

/** Human label per dedupe reason — order here is the display order in the banner. */
const DEDUPE_REASON_LABEL: Record<EnqueueDedupedRow['reason'], string> = {
  already_running: 'already running',
  already_in_queue: 'already in queue',
  already_complete: 'already complete',
  already_skipped: 'already skipped',
};

export function summarizeDedupeReasons(rows: EnqueueDedupedRow[]): string {
  const counts: Partial<Record<EnqueueDedupedRow['reason'], number>> = {};
  for (const row of rows) {
    counts[row.reason] = (counts[row.reason] ?? 0) + 1;
  }
  return (Object.entries(DEDUPE_REASON_LABEL) as Array<[EnqueueDedupedRow['reason'], string]>)
    .filter(([reason]) => (counts[reason] ?? 0) > 0)
    .map(([reason, label]) => `${counts[reason]} ${label}`)
    .join(' · ');
}

export interface HeaderSummary {
  done: number;
  failed: number;
  capturing: number;
  queued: number;
  total: number;
  paused: boolean;
}

export function computeHeaderSummary(snap: QueueSnapshot): HeaderSummary {
  const done = snap.done.filter((i) => i.phase === 'done' || i.phase === 'skipped').length;
  const failed = snap.done.filter((i) => i.phase === 'failed').length;
  const capturing = snap.active.length;
  const queued = snap.queued.length;
  return {
    done, failed, capturing, queued,
    total: done + failed + snap.done.filter((i) => i.phase === 'cancelled').length + capturing + queued,
    paused: snap.paused,
  };
}

const VIRTUALIZE_THRESHOLD = 200;

export function CaptureQueue() {
  const { queue, cancelItem, cancelAll, dismissDone, resumeQueue, retryItems } = useCaptureQueue();
  const { data: symbolsResp } = useSymbols();
  const { data: stockDates } = useStockDates();
  const nameByCode = useMemo(() => {
    const m = new Map<string, string>();
    (symbolsResp?.symbols ?? []).forEach((s) => m.set(s.code, s.name));
    return m;
  }, [symbolsResp]);
  // Lookup Full Capture Count by (code, date) for each queue row.
  // Returns `null` when no prior meta.json exists (a brand-new capture);
  // returns the persisted counter (incl. legacy null) when meta.json
  // is present on disk. SSE inventory_added invalidates the underlying
  // query, so done rows refresh to the post-increment value within ~ms.
  const fullCaptureCountByKey = useMemo(() => {
    const m = new Map<string, number | null>();
    (stockDates ?? []).forEach((sd) => m.set(`${sd.code}|${sd.date}`, sd.full_capture_count));
    return m;
  }, [stockDates]);

  const [cancelAllArmed, setCancelAllArmed] = useState(false);
  const cancelAllTimerRef = useRef<number | null>(null);

  // Dedupe banner: subscribe to the latest CaptureForm-issued addItems response via the
  // shared mutationKey. We can't read `addItems.data` directly because CaptureForm holds
  // its own useMutation instance (sibling component, separate React Query state).
  const addItemsSubmissions = useMutationState<{
    data: EnqueueResponse | undefined;
    submittedAt: number;
  }>({
    filters: { mutationKey: ADD_ITEMS_MUTATION_KEY },
    select: (m) => ({
      data: m.state.data as EnqueueResponse | undefined,
      submittedAt: m.state.submittedAt,
    }),
  });
  const lastAddItems = addItemsSubmissions[addItemsSubmissions.length - 1];
  const lastDedupedRows = lastAddItems?.data?.deduped ?? [];
  const [dismissedSubmittedAt, setDismissedSubmittedAt] = useState<number>(0);
  const showDedupedBanner =
    lastDedupedRows.length > 0
    && lastAddItems !== undefined
    && lastAddItems.submittedAt !== dismissedSubmittedAt;

  // Hook called unconditionally — when queue is undefined, treat as empty.
  const allRows: QueueItem[] = useMemo(() => {
    if (queue === undefined) return [];
    const merged = [...queue.active, ...queue.queued, ...queue.done];
    merged.sort((a, b) => {
      const p = GROUP_ORDER[getPhase(a.phase).group] - GROUP_ORDER[getPhase(b.phase).group];
      if (p !== 0) return p;
      return a.enqueued_at_ms - b.enqueued_at_ms;
    });
    return merged;
  }, [queue]);

  const handleCancelAll = () => {
    if (cancelAllArmed) {
      if (cancelAllTimerRef.current !== null) window.clearTimeout(cancelAllTimerRef.current);
      cancelAllTimerRef.current = null;
      setCancelAllArmed(false);
      cancelAll.mutate();
      return;
    }
    setCancelAllArmed(true);
    cancelAllTimerRef.current = window.setTimeout(() => setCancelAllArmed(false), 4_000);
  };

  if (queue === undefined) {
    return <InlineState className="border-0 bg-transparent p-3">Loading queue…</InlineState>;
  }

  const totalRows = queue.active.length + queue.queued.length + queue.done.length;
  if (totalRows === 0 && !queue.paused) {
    return (
      <EmptyState testId="queue-empty" title="큐가 비어 있습니다">
        왼쪽에서 종목과 날짜 범위를 선택하고 Start 를 누르면 캡처가 시작됩니다.
      </EmptyState>
    );
  }

  const summary = computeHeaderSummary(queue);

  const onRetry = (item: QueueItem) => {
    retryItems.mutate({ item_ids: [item.item_id] });
  };

  const shouldVirtualize = allRows.length > VIRTUALIZE_THRESHOLD;

  return (
    <div className="flex flex-col gap-2 h-full">
      <div className="flex items-center gap-3 px-sm">
        <div className="flex-1 font-medium text-sm font-mono text-fg-dim tabular-nums">
          {summary.done} of {summary.total} done · {summary.failed} failed · {summary.capturing} capturing
        </div>
        <button
          type="button"
          onClick={handleCancelAll}
          style={cancelAllArmed
            ? ghostButton('var(--error)', 'var(--error)')
            : ghostButton()
          }
        >{cancelAllArmed ? 'Click again to confirm' : 'Cancel All'}</button>
        <button
          type="button"
          disabled={summary.failed === 0}
          onClick={() => {
            const ids = queue.done
              .filter((i) => i.phase === 'failed')
              .map((i) => i.item_id);
            if (ids.length > 0) retryItems.mutate({ item_ids: ids });
          }}
          style={summary.failed === 0 ? ghostButtonDisabled() : ghostButton()}
        >Retry Failed</button>
        <button
          type="button"
          onClick={() => dismissDone.mutate()}
          style={ghostButton()}
        >Dismiss Done</button>
      </div>

      <div className="h-1 bg-bg-input rounded-sm relative">
        <div style={{ width: `${summary.total > 0 ? (summary.done / summary.total) * 100 : 0}%` }}
          className="absolute left-0 top-0 bottom-0 bg-accent rounded-sm" />
      </div>

      {showDedupedBanner && lastAddItems !== undefined && (
        <InlineState
          data-testid="deduped-banner"
          role="status"
          tone="accent"
          className="py-sm flex items-center gap-3 font-medium font-mono"
        >
          <span aria-hidden>ⓘ</span>
          <span className="flex-1">{summarizeDedupeReasons(lastDedupedRows)}</span>
          <button
            type="button"
            aria-label="Dismiss dedupe notice"
            onClick={() => setDismissedSubmittedAt(lastAddItems.submittedAt)}
            style={ghostButton()}
          >Dismiss</button>
        </InlineState>
      )}

      {queue.paused && (
        <InlineState role="alert" tone="warn" className="py-sm flex items-center gap-3 font-medium font-mono">
          <span className="flex-1">Cookie expired · refresh .cookie on disk, then resume</span>
          <button type="button" onClick={() => resumeQueue.mutate()} style={ghostButton()}>Refresh &amp; Resume</button>
          <button type="button" onClick={() => cancelAll.mutate()} style={ghostButton()}>Cancel All</button>
        </InlineState>
      )}

      <div
        data-testid="queue-list"
        data-virtualized={shouldVirtualize}
        className="flex-1 overflow-y-auto border rounded-md"
      >
        {shouldVirtualize
          ? <VirtualList
              rows={allRows}
              nameByCode={nameByCode}
              fullCaptureCountByKey={fullCaptureCountByKey}
              onCancel={cancelItem.mutate}
              onRetry={onRetry}
            />
          : allRows.map((row) => (
              <CaptureQueueRow
                key={row.item_id}
                item={row}
                symbolName={nameByCode.get(row.code) ?? '—'}
                fullCaptureCount={fullCaptureCountByKey.get(`${row.code}|${row.date}`)}
                onCancel={cancelItem.mutate}
                onRetry={onRetry}
              />
            ))}
      </div>
    </div>
  );
}

function VirtualList({
  rows, nameByCode, fullCaptureCountByKey, onCancel, onRetry,
}: {
  rows: QueueItem[];
  nameByCode: Map<string, string>;
  fullCaptureCountByKey: Map<string, number | null>;
  onCancel: (itemId: string) => void;
  onRetry: (item: QueueItem) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 36,
    overscan: 8,
  });
  return (
    <div ref={parentRef} style={{ height: '100%', overflowY: 'auto' }}>
      <div style={{ height: v.getTotalSize(), position: 'relative' }}>
        {v.getVirtualItems().map((vr) => {
          const row = rows[vr.index];
          return (
            <div key={row.item_id} style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${vr.start}px)` }}>
              <CaptureQueueRow
                item={row}
                symbolName={nameByCode.get(row.code) ?? '—'}
                fullCaptureCount={fullCaptureCountByKey.get(`${row.code}|${row.date}`)}
                onCancel={onCancel}
                onRetry={onRetry}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ghostButtonDisabled(): React.CSSProperties {
  return { ...ghostButton(), opacity: 0.5, cursor: 'not-allowed' };
}

function ghostButton(borderColor = 'var(--border-strong)', fgColor = 'var(--fg-dim)'): React.CSSProperties {
  // Use longhand border properties (borderWidth / borderStyle / borderColor)
  // so callers can override borderColor without React's "shorthand and
  // non-shorthand on the same value" warning (BUG-002 from /qa).
  return {
    background: 'transparent',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor,
    color: fgColor,
    borderRadius: 4,
    padding: '4px 10px',
    font: '500 var(--text-xs) "Geist Sans", sans-serif',
    letterSpacing: '0.04em',
    cursor: 'pointer',
  };
}
