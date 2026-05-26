import type { ManualCatchupAllEntryResult } from '../api/watchlist';

/** Inputs the caught_up_one banner needs to render its message.
 * Deliberately a narrow shape (not the full RecentAction discriminator)
 * so the formatter doesn't have to know about Panel state. */
export interface CaughtUpOneMessageInput {
  name: string;
  code: string;
  enqueued: number;
  deduped: number;
  error?: string;
}

/** Map the five cases of caught_up_one to a Korean string.
 *
 * Cases (in priority order):
 *   1. error present              → "{name} ({code}) 수집 실패: {error}"
 *   2. enqueued=0 AND deduped=0   → "{name} ({code}) 수집할 거래일 없음"
 *   3. enqueued=0 AND deduped>0   → "✓ {name} ({code}) 이미 모두 수집됨 ({deduped}건)"
 *   4. enqueued>0 AND deduped>0   → "✓ {name} ({code}) 수집 대기 중 — {enqueued}건 추가, {deduped}건 이미 완료"
 *   5. enqueued>0 AND deduped=0   → "✓ {name} ({code}) 수집 대기 중 — {enqueued}건 추가"
 */
export function formatCaughtUpOneMessage(input: CaughtUpOneMessageInput): string {
  const { name, code, enqueued, deduped, error } = input;
  if (error) return `${name} (${code}) 수집 실패: ${error}`;
  if (enqueued === 0 && deduped === 0) return `${name} (${code}) 수집할 거래일 없음`;
  if (enqueued === 0) return `✓ ${name} (${code}) 이미 모두 수집됨 (${deduped}건)`;
  if (deduped > 0) return `✓ ${name} (${code}) 수집 대기 중 — ${enqueued}건 추가, ${deduped}건 이미 완료`;
  return `✓ ${name} (${code}) 수집 대기 중 — ${enqueued}건 추가`;
}

/** Aggregated view of a ManualCatchupAllResponse.results list. */
export interface CaughtUpAllSummary {
  /** Total number of entries that were attempted (whole watchlist). */
  total: number;
  /** Sum of enqueued_count across all entries. */
  enqueuedTotal: number;
  /** Sum of deduped_count across all entries. */
  dedupedTotal: number;
  /** Entries where the catch-up raised an exception (error != null). */
  failed: ManualCatchupAllEntryResult[];
}

export function summarizeCaughtUpAll(
  results: ManualCatchupAllEntryResult[],
): CaughtUpAllSummary {
  return {
    total: results.length,
    enqueuedTotal: results.reduce((s, r) => s + r.enqueued_count, 0),
    dedupedTotal: results.reduce((s, r) => s + r.deduped_count, 0),
    failed: results.filter((r) => r.error != null),
  };
}

/** Format the single-line header for the caught_up_all banner. */
export function formatCaughtUpAllHeader(summary: CaughtUpAllSummary): string {
  const trailing = summary.failed.length > 0
    ? `, ${summary.failed.length}종목 실패`
    : '';
  return `✓ 전체 catch-up: ${summary.total}종목, ${summary.enqueuedTotal}건 추가, ${summary.dedupedTotal}건 이미 완료${trailing}`;
}
