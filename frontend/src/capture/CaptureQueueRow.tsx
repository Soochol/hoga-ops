import { useState } from 'react';
import { CaptureRowDetail } from './CaptureRowDetail';
import { getPhase } from './phase';
import { useInventoryRecaptureOrigins } from '../inventory/useInventoryRecaptureOrigins';
import type { QueueItem } from '../api/types';
import { FullCaptureCountBadge } from '../ui/FullCaptureCountBadge';
import { StatusBadge } from '../ui/StatusBadge';

export interface CaptureQueueRowProps {
  item: QueueItem;
  symbolName: string;
  /** Full Capture Count for (item.code, item.date), sourced from
   *  `useStockDates()` in the parent. Optional so unit tests focused on
   *  other behavior can omit it (treated as undefined → "—").
   *  - `undefined` → no meta.json on disk (a brand-new capture, no history)
   *  - `null` → legacy meta.json without the counter field (treated as ×1)
   *  - `number` → persisted count (≥1)
   *  Done rows refresh post-increment via SSE inventory_added invalidation. */
  fullCaptureCount?: number | null;
  onCancel: (itemId: string) => void;
  /** Retry the failed item; CaptureQueue routes this through the retryItems mutation (ADR-0031). */
  onRetry: (item: QueueItem) => void;
}

export function CaptureQueueRow({
  item, symbolName, fullCaptureCount, onCancel, onRetry,
}: CaptureQueueRowProps) {
  const [expanded, setExpanded] = useState(false);
  const isFromInventory = useInventoryRecaptureOrigins((s) => s.ids.has(item.item_id));
  const descriptor = getPhase(item.phase);
  const showCancel = !descriptor.terminal;
  const showRetry = item.phase === 'failed';

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setExpanded((v) => !v);
    }
  };

  return (
    <>
      <div
        data-testid={`queue-row-${item.item_id}`}
        data-expanded={expanded}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={`Capture row ${item.code} ${item.date} ${item.phase}. Press Enter to ${expanded ? 'collapse' : 'expand'} details.`}
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={onKeyDown}
        className="grid grid-cols-[1rem_2.6rem_4.5rem_3rem_1fr_4.5rem_2.5rem_2.5rem_6rem_1.2rem] items-center gap-2 h-capture-row px-sm border-b font-medium text-sm font-mono tabular-nums text-fg cursor-pointer outline-none"
      >
        <span>{descriptor.icon}</span>
        <span data-testid="queue-row-full-capture-count">
          <FullCaptureCountBadge n={fullCaptureCount} />
        </span>
        <span>{item.date}</span>
        <span>{item.code}</span>
        <span className="font-normal text-sm text-fg-dim">
          {symbolName}
          {item.force_retry && (
            <StatusBadge tone="warn" title="Force re-capture" className="ml-1.5">⚠ force</StatusBadge>
          )}
          {item.attempt > 1 && (
            <StatusBadge tone="dim" title={`Attempt ${item.attempt}`} className="ml-1.5">×{item.attempt}</StatusBadge>
          )}
          {isFromInventory && (
            <StatusBadge tone="dim" title="Triggered from inventory re-capture" className="ml-1.5">inventory</StatusBadge>
          )}
        </span>
        <span style={{ background: descriptor.chipColor }} className="py-[0.1rem] px-xs rounded-md text-fg-dim">
          {item.phase}
        </span>
        <span>{item.progress?.pages_done ?? '–'}</span>
        <span>{item.progress?.events_seen ?? '–'}</span>
        <span className="flex items-center gap-1.5">
          <span className="flex-1 h-0.5 bg-bg-input rounded-sm relative">
            <span style={{ width: `${item.progress?.estimate_pct ?? 0}%` }}
              className="absolute left-0 top-0 bottom-0 bg-accent rounded-sm" />
          </span>
          <span className="w-7 text-right text-fg-dim">
            {item.progress?.estimate_pct !== undefined ? `${item.progress.estimate_pct}%` : '–'}
          </span>
        </span>
        <span className="flex justify-end">
          {showCancel && (
            <button
              type="button"
              aria-label="Cancel"
              onClick={(e) => { e.stopPropagation(); onCancel(item.item_id); }}
              className="bg-transparent border-none text-fg-dim cursor-pointer text-sm p-0"
            >✕</button>
          )}
          {showRetry && (
            <button
              type="button"
              aria-label="Retry"
              onClick={(e) => { e.stopPropagation(); onRetry(item); }}
              className="bg-transparent border-none text-accent cursor-pointer text-sm p-0"
            >↻</button>
          )}
        </span>
      </div>
      {expanded && <CaptureRowDetail item={item} />}
    </>
  );
}
