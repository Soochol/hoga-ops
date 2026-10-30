import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MarketRankEvidence } from '../MarketRankEvidence';
import { makeLeaf } from '../catalog';
import { monitorPeriod } from '../useScreenerMonitor';

describe('change percentage market ranks', () => {
  it('keeps both rank observations available and preserves the signed percentage', () => {
    const activate = vi.fn();
    render(<div onClick={activate}><MarketRankEvidence row={{ name: '삼성전자', occurrences: [
      { condition_id: 'v', condition_key: 'v', date: '2026-10-30', trade_value_rank_match: {
        rank: 150, trade_value_won: 5e10, market: 'all', venue: 'UN', fetched_at_ms: 1 } },
      { condition_id: 'c', condition_key: 'c', date: '2026-10-30', change_pct_rank_match: {
        rank: 199, change_pct: -1.23, market: 'all', venue: 'UN', fetched_at_ms: 1 } },
    ] }} /></div>);
    expect(screen.getByRole('button', { name: '삼성전자 거래대금 순위 근거' })).toHaveTextContent('150위');
    fireEvent.click(screen.getByRole('button', { name: '삼성전자 등락률 순위 근거' }));
    const dialog = screen.getByRole('dialog', { name: '삼성전자 등락률 순위 근거' });
    expect(dialog).toHaveTextContent('등락률 199위');
    expect(dialog).toHaveTextContent('전일 종가 대비 -1.23%');
    expect(activate).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('button', { name: /닫기/ }), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '삼성전자 거래대금 순위 근거' }));
    expect(screen.getByRole('dialog', { name: '삼성전자 거래대금 순위 근거' })).toHaveTextContent('500억');
  });
  it('defaults to top 100 and ten-second automatic refresh', () => {
    const leaf = makeLeaf('change_pct_rank');
    expect(leaf.params).toEqual({ top_n: 100 });
    expect(monitorPeriod([leaf], false)).toBe(10_000);
    expect(monitorPeriod([leaf], true)).toBe(10_000);
  });
});
