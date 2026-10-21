import type { RankingKind, RankingRow } from '../api/liveRankings';

export type RankingMetric = { text: string; title: string };

const INTEGER = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });
const PERCENT = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 });
const finite = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** Display snapshots are also used by the drag ghost, so text and units match. */
export function rankingMetricFor(row: RankingRow, kind: RankingKind): RankingMetric | undefined {
  if (kind === 'change') {
    const value = row.change_won;
    const text = finite(value) ? `${value > 0 ? '+' : value < 0 ? '-' : ''}${INTEGER.format(Math.abs(value))}원` : '—';
    return { text, title: `전일대비 ${text}` };
  }
  if (kind === 'surge') {
    const text = finite(row.volume_surge_pct) ? `${PERCENT.format(row.volume_surge_pct)}%` : '—';
    // The existing ka10023 request uses tm_tp=1, tm=1. Keep the vendor's
    // percentage rather than deriving a different ratio from volume fields.
    return { text, title: `1분 기준 급증률 ${text}` };
  }
  if (kind === 'volume') {
    const value = row.volume;
    if (!finite(value) || !Number.isSafeInteger(value) || value < 0) return { text: '—', title: '당일 거래량 —' };
    const exact = `${INTEGER.format(value)}주`;
    return { text: value >= 10_000 ? `${INTEGER.format(value / 10_000)}만주` : exact, title: `당일 거래량 ${exact}` };
  }
  return undefined;
}
