import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCaptureQueue } from './useCaptureQueue';
import { useSymbols } from './useSymbols';
import { CaptureQueueRow } from './CaptureQueueRow';
import { GROUP_ORDER, getPhase } from './phase';
import type { QueueItem, QueueSnapshot } from '../api/types';

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
  const nameByCode = useMemo(() => {
    const m = new Map<string, string>();
    (symbolsResp?.symbols ?? []).forEach((s) => m.set(s.code, s.name));
    return m;
  }, [symbolsResp]);

  const [cancelAllArmed, setCancelAllArmed] = useState(false);
  const cancelAllTimerRef = useRef<number | null>(null);

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
    return <div className="p-3 text-fg-dim">Loading queue…</div>;
  }

  const totalRows = queue.active.length + queue.queued.length + queue.done.length;
  if (totalRows === 0 && !queue.paused) {
    return (
      <div
        data-testid="queue-empty"
        className="h-full flex flex-col items-center justify-center gap-2 p-6 text-fg-dim font-normal text-sm text-center"
      >
        <div className="font-medium text-base text-fg">
          큐가 비어 있습니다
        </div>
        <div>
          왼쪽에서 종목과 날짜 범위를 선택하고 Start 를 누르면 캡처가 시작됩니다.
        </div>
      </div>
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

      {queue.paused && (
        <div role="alert" className="py-sm px-3 flex items-center gap-3 font-medium text-sm font-mono rounded-md border border-[--warn]"
          style={{ background: 'rgba(245,158,11,0.10)', color: 'var(--warn)' }}>
          <span className="flex-1">Cookie expired · refresh .cookie on disk, then resume</span>
          <button type="button" onClick={() => resumeQueue.mutate()} style={ghostButton()}>Refresh &amp; Resume</button>
          <button type="button" onClick={() => cancelAll.mutate()} style={ghostButton()}>Cancel All</button>
        </div>
      )}

      <div
        data-testid="queue-list"
        data-virtualized={shouldVirtualize}
        className="flex-1 overflow-y-auto border rounded-md"
      >
        {shouldVirtualize
          ? <VirtualList rows={allRows} nameByCode={nameByCode} onCancel={cancelItem.mutate} onRetry={onRetry} />
          : allRows.map((row) => (
              <CaptureQueueRow
                key={row.item_id}
                item={row}
                symbolName={nameByCode.get(row.code) ?? '—'}
                onCancel={cancelItem.mutate}
                onRetry={onRetry}
              />
            ))}
      </div>
    </div>
  );
}

function VirtualList({
  rows, nameByCode, onCancel, onRetry,
}: {
  rows: QueueItem[];
  nameByCode: Map<string, string>;
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
