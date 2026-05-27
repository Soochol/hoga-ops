import type { ManualCatchupAllEntryResult } from '../api/watchlist';

export function symbolLabel(s: { name: string; code: string }): string {
  return `${s.name} (${s.code})`;
}

export interface CaughtUpOneMessageInput {
  name: string;
  code: string;
  enqueued: number;
  deduped: number;
  error?: string;
}

export function formatCaughtUpOneMessage(input: CaughtUpOneMessageInput): string {
  const { enqueued, deduped, error } = input;
  const who = symbolLabel(input);
  if (error) return `${who} 수집 실패: ${error}`;
  if (enqueued === 0 && deduped === 0) return `${who} 수집할 거래일 없음`;
  if (enqueued === 0) return `✓ ${who} 이미 모두 수집됨 (${deduped}건)`;
  if (deduped > 0) return `✓ ${who} 수집 대기 중 — ${enqueued}건 추가, ${deduped}건 이미 완료`;
  return `✓ ${who} 수집 대기 중 — ${enqueued}건 추가`;
}

/** Aggregated view of a ManualCatchupAllResponse.results list. */
export interface CaughtUpAllSummary {
  total: number;
  enqueuedTotal: number;
  dedupedTotal: number;
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

export function formatCaughtUpAllHeader(summary: CaughtUpAllSummary): string {
  const trailing = summary.failed.length > 0
    ? `, ${summary.failed.length}종목 실패`
    : '';
  return `✓ 전체 catch-up: ${summary.total}종목, ${summary.enqueuedTotal}건 추가, ${summary.dedupedTotal}건 이미 완료${trailing}`;
}
