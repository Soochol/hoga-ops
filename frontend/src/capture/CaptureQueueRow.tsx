import { useState } from 'react';
import { CaptureRowDetail } from './CaptureRowDetail';
import type { CapturePhase, QueueItem } from '../api/types';

export function statusIcon(phase: CapturePhase): string {
  switch (phase) {
    case 'done': return '✓';
    case 'failed': return '✕';
    case 'cancelled': return '✕';
    case 'skipped': return '⚠';
    case 'capturing': case 'parsing': case 'deciding': return '●';
    case 'queued': default: return '○';
  }
}

export function phaseChipColor(phase: CapturePhase): string {
  if (phase === 'capturing' || phase === 'parsing' || phase === 'deciding') return 'rgba(20,184,166,0.12)';
  if (phase === 'done') return 'rgba(34,197,94,0.10)';
  if (phase === 'failed') return 'rgba(244,63,94,0.10)';
  return 'rgba(148,163,184,0.10)';
}

export interface CaptureQueueRowProps {
  item: QueueItem;
  symbolName: string;
  onCancel: (itemId: string) => void;
  /** Re-enqueue with same params; CaptureQueue passes the addItems mutation here. */
  onRetry: (item: QueueItem) => void;
}

export function CaptureQueueRow({ item, symbolName, onCancel, onRetry }: CaptureQueueRowProps) {
  const [expanded, setExpanded] = useState(false);
  const isTerminal = item.phase === 'done' || item.phase === 'skipped' || item.phase === 'cancelled' || item.phase === 'failed';
  const showCancel = !isTerminal;
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
        style={{
          display: 'grid',
          gridTemplateColumns: '20px 90px 60px 1fr 90px 50px 50px 80px 24px',
          alignItems: 'center', gap: 8,
          height: 36, padding: '0 8px',
          borderBottom: '1px solid var(--border)',
          font: '500 11px "Geist Mono", monospace',
          fontVariantNumeric: 'tabular-nums',
          color: 'var(--fg)',
          cursor: 'pointer',
          outline: 'none',
        }}
      >
        <span>{statusIcon(item.phase)}</span>
        <span>{item.date}</span>
        <span>{item.code}</span>
        <span style={{ font: '400 12px "Geist Sans", sans-serif', color: 'var(--fg-dim)' }}>
          {symbolName}
          {item.force_retry && (
            <span title="Force re-capture" style={{
              marginLeft: 6, fontSize: 9,
              border: '1px solid var(--warn)',
              color: 'var(--warn)',
              borderRadius: 3, padding: '0 3px',
            }}>⚠ force</span>
          )}
        </span>
        <span style={{ background: phaseChipColor(item.phase), padding: '2px 6px', borderRadius: 3, color: 'var(--fg-dim)' }}>
          {item.phase}
        </span>
        <span>{item.progress?.pages_done ?? '–'}</span>
        <span>{item.progress?.events_seen ?? '–'}</span>
        <span style={{ width: 80, height: 2, background: 'var(--bg-input)', borderRadius: 1, position: 'relative' }}>
          <span style={{
            position: 'absolute', left: 0, top: 0, bottom: 0,
            width: `${item.progress?.estimate_pct ?? 0}%`,
            background: 'var(--accent)', borderRadius: 1,
          }} />
        </span>
        <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
          {showCancel && (
            <button
              type="button"
              aria-label="Cancel"
              onClick={(e) => { e.stopPropagation(); onCancel(item.item_id); }}
              style={{
                background: 'transparent', border: 'none', color: 'var(--fg-dim)',
                cursor: 'pointer', fontSize: 14, padding: 0,
              }}
            >✕</button>
          )}
          {showRetry && (
            <button
              type="button"
              aria-label="Retry"
              onClick={(e) => { e.stopPropagation(); onRetry(item); }}
              style={{
                background: 'transparent', border: 'none', color: 'var(--accent)',
                cursor: 'pointer', fontSize: 14, padding: 0,
              }}
            >↻</button>
          )}
        </span>
      </div>
      {expanded && <CaptureRowDetail item={item} />}
    </>
  );
}
