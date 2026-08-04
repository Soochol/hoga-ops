/** Pure summary helpers for CaptureQueue, split out so CaptureQueue.tsx exports
 *  only the component — mixed exports disable Vite Fast Refresh for the file. */
import type { EnqueueDedupedRow, QueueSnapshot } from '../api/types';

/** Human label per dedupe reason — order here is the display order in the banner. */
const DEDUPE_REASON_LABEL: Record<EnqueueDedupedRow['reason'], string> = {
  already_running: '이미 수집 중',
  already_in_queue: '이미 대기 중',
  already_complete: '이미 완료',
  already_skipped: '이미 건너뜀',
};

export function summarizeDedupeReasons(rows: EnqueueDedupedRow[]): string {
  const counts: Partial<Record<EnqueueDedupedRow['reason'], number>> = {};
  for (const row of rows) {
    counts[row.reason] = (counts[row.reason] ?? 0) + 1;
  }
  return (Object.entries(DEDUPE_REASON_LABEL) as Array<[EnqueueDedupedRow['reason'], string]>)
    .filter(([reason]) => (counts[reason] ?? 0) > 0)
    .map(([reason, label]) => `${label} ${counts[reason]}건`)
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
