import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ScreenerOccurrence } from '../api/screener';
import type { RankingBasis } from '../api/rankingBasis';
import { BarMatchEvidence } from './BarMatchEvidence';

const provider: RankingBasis = { source: 'provider', session: 'holiday', trading_date: null,
  observed_at_ms: null, message: null };
const received = Date.parse('2026-11-01T12:00:00+09:00');
const common = { rank: 1, market: 'all' as const, venue: 'KRX' as const, fetched_at_ms: received, basis: provider };
const examples: Partial<ScreenerOccurrence>[] = [
  { trade_value_rank_match: { ...common, trade_value_won: 1e9 } },
  { change_pct_rank_match: { ...common, change_pct: 10 } },
  ...(['surge', 'volume', 'program', 'institution', 'foreign'] as const).map(kind => ({
    market_rank_match: { ...common, kind, quote_venue: null, volume: 100, volume_surge_pct: 200, net_buy_won: 1e9 },
  })),
];

describe('ranking source evidence', () => {
  it.each(examples)('shows an undated provider receipt separately from the evaluation day %#', evidence => {
    const { container } = render(<BarMatchEvidence event={{ condition_id: 'rank', condition_key: 'rank',
      date: '2026-10-30', ...evidence }} />);
    expect(container).toHaveTextContent('평가 기준일 2026-10-30');
    expect(container).toHaveTextContent('순위 거래일 미확인');
    expect(container).toHaveTextContent('12:00:00 조회');
    expect(container).not.toHaveTextContent('관측');
  });

  it('preserves a stored observation date and time', () => {
    render(<BarMatchEvidence event={{ condition_id: 'rank', condition_key: 'rank', date: '2026-10-30',
      trade_value_rank_match: { ...common, trade_value_won: 1e9,
        fetched_at_ms: Date.parse('2026-10-30T14:20:00+09:00'),
        basis: { ...provider, source: 'stored', trading_date: '2026-10-30',
          observed_at_ms: Date.parse('2026-10-30T14:20:00+09:00') } } }} />);
    expect(screen.getByText(/관측 · 저장된 순위/)).toHaveTextContent('14:20:00');
    expect(screen.queryByText(/순위 거래일 미확인/)).not.toBeInTheDocument();
  });
});
