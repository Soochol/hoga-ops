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
  const { queue, cancelItem, cancelAll, dismissDone, addItems, resumeQueue } = useCaptureQueue();
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
    return <div style={{ padding: 12, color: 'var(--fg-dim)' }}>Loading queue…</div>;
  }

  const totalRows = queue.active.length + queue.queued.length + queue.done.length;
  if (totalRows === 0 && !queue.paused) {
    return (
      <div
        data-testid="queue-empty"
        style={{
          height: '100%',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          gap: 8,
          padding: 24,
          color: 'var(--fg-dim)',
          font: '400 12px "Geist Sans", sans-serif',
          textAlign: 'center',
        }}
      >
        <div style={{ font: '500 13px "Geist Sans", sans-serif', color: 'var(--fg)' }}>
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
    addItems.mutate({
      code: item.code,
      dates: [item.date],
      force_retry: item.force_retry,
    });
  };

  const shouldVirtualize = allRows.length > VIRTUALIZE_THRESHOLD;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '0 8px' }}>
        <div style={{ flex: 1, font: '500 11px "Geist Mono", monospace', color: 'var(--fg-dim)', fontVariantNumeric: 'tabular-nums' }}>
          {summary.done} of {summary.total} done · {summary.failed} failed · {summary.capturing} capturing
        </div>
        <button
          type="button"
          onClick={handleCancelAll}
          style={cancelAllArmed
            ? { ...ghostButton(), borderColor: 'var(--down)', color: 'var(--down)' }
            : ghostButton()
          }
        >{cancelAllArmed ? 'Click again to confirm' : 'Cancel All'}</button>
        <button
          type="button"
          onClick={() => dismissDone.mutate()}
          style={ghostButton()}
        >Dismiss Done</button>
      </div>

      <div style={{ height: 4, background: 'var(--bg-input)', borderRadius: 1, position: 'relative' }}>
        <div style={{
          position: 'absolute', left: 0, top: 0, bottom: 0,
          width: `${summary.total > 0 ? (summary.done / summary.total) * 100 : 0}%`,
          background: 'var(--accent)', borderRadius: 1,
        }} />
      </div>

      {queue.paused && (
        <div role="alert" style={{
          padding: '8px 12px', background: 'rgba(245,158,11,0.10)', border: '1px solid var(--warn)',
          borderRadius: 4, display: 'flex', alignItems: 'center', gap: 12,
          font: '500 11px "Geist Mono", monospace', color: 'var(--warn)',
        }}>
          <span style={{ flex: 1 }}>Cookie expired · refresh .cookie on disk, then resume</span>
          <button type="button" onClick={() => resumeQueue.mutate()} style={ghostButton()}>Refresh &amp; Resume</button>
          <button type="button" onClick={() => cancelAll.mutate()} style={ghostButton()}>Cancel All</button>
        </div>
      )}

      <div
        data-testid="queue-list"
        data-virtualized={shouldVirtualize}
        style={{ flex: 1, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 4 }}
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

function ghostButton(): React.CSSProperties {
  return {
    background: 'transparent',
    border: '1px solid var(--border-strong)',
    color: 'var(--fg-dim)',
    borderRadius: 4,
    padding: '4px 10px',
    font: '500 10.5px "Geist Sans", sans-serif',
    letterSpacing: '0.04em',
    cursor: 'pointer',
  };
}
