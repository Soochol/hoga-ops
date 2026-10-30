import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BarMatchEvidence } from '../BarMatchEvidence';
import { makeLeaf } from '../catalog';
import { MarketRankEvidence } from '../MarketRankEvidence';
import { monitorPeriod } from '../useScreenerMonitor';

describe('trade value ranking evidence', () => {
  it('shows provider rank, market, venue, amount and KST observation time', () => {
    render(<BarMatchEvidence event={{ condition_id: 'rank', condition_key: 'rank', date: '2026-10-30',
      trade_value_rank_match: { rank: 199, trade_value_won: 5e10, market: 'kosdaq', venue: 'UN',
        fetched_at_ms: Date.parse('2026-10-30T10:20:00+09:00') } }} />);
    expect(screen.getByText(/코스닥.*통합.*거래대금 199위.*500억/)).toHaveTextContent('10:20:00');
  });
  it('opens the recorded rank without activating the row', () => {
    const onClick = vi.fn();
    render(<div onClick={onClick}><MarketRankEvidence row={{ name: '삼성전자', occurrences: [
        { condition_id: 'r', condition_key: 'r', date: '2026-10-30', trade_value_rank_match: { rank: 199,
          trade_value_won: 5e10, market: 'all', venue: 'KRX', fetched_at_ms: 1 } },
      ] }} /></div>);
    fireEvent.click(screen.getByRole('button', { name: '삼성전자 거래대금 순위 근거' }));
    expect(screen.getByRole('dialog', { name: '삼성전자 거래대금 순위 근거' })).toHaveTextContent('거래대금 199위');
    expect(onClick).not.toHaveBeenCalled();
  });
  it('uses ten-second automatic polling with a ranking condition', () => {
    expect(monitorPeriod([makeLeaf('trade_value_rank')], false)).toBe(10_000);
    expect(monitorPeriod([makeLeaf('trade_value_rank')], true)).toBe(10_000);
    expect(monitorPeriod([makeLeaf('trade_value')], false)).toBe(30_000);
    expect(monitorPeriod([makeLeaf('trade_value')], true)).toBe(15_000);
  });
});
