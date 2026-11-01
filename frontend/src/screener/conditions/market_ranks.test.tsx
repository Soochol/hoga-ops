import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CONDITION_CATALOG, makeLeaf } from '../catalog';
import { MarketRankEvidence } from '../MarketRankEvidence';
import { monitorPeriod } from '../useScreenerMonitor';
import { screenerRequestKey } from '../../api/screenerRequest';
import type { MarketRankKind, ScreenerOccurrence } from '../../api/screener';

const types = ['volume_surge_rank', 'volume_rank', 'program_net_buy_rank',
  'institution_net_buy_rank', 'foreign_net_buy_rank'] as const;

describe('우측 패널 순위 조건', () => {
  it.each(types)('%s uses the panel default, polling period and integer boundary', type => {
    const entry = CONDITION_CATALOG[type];
    const Form = entry.ParamForm;
    const onChange = vi.fn();
    const slow = type.includes('net_buy');
    const investor = type === 'institution_net_buy_rank' || type === 'foreign_net_buy_rank';
    expect(entry.defaultParams.top_n).toBe(type === 'program_net_buy_rank' ? 50 : 100);
    expect(monitorPeriod([makeLeaf(type)], false)).toBe(slow ? 30_000 : 10_000);
    render(<Form params={entry.defaultParams} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '1.5' } });
    fireEvent.blur(input);
    expect(screen.getByRole('alert')).toHaveTextContent('정수로 입력하세요.');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: investor ? '101' : '5001' } });
    fireEvent.blur(input);
    expect(screen.getByRole('alert')).toHaveTextContent(investor ? '100 이하' : '5000 이하');
    fireEvent.change(input, { target: { value: '50' } });
    expect(onChange).toHaveBeenLastCalledWith({ top_n: 50 });
  });

  it('keeps upward and downward semantics separate without changing old request keys', () => {
    const entry = CONDITION_CATALOG.change_pct_rank;
    const Form = entry.ParamForm;
    const onChange = vi.fn();
    render(<Form params={{ top_n: 200 }} onChange={onChange} />);
    expect(screen.getByRole('combobox', { name: '등락률 순위 방향' })).toHaveValue('up');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'down' } });
    expect(onChange).toHaveBeenLastCalledWith({ top_n: 200, direction: 'down' });
    expect(entry.summarize({ top_n: 200, direction: 'down' })).toContain('하락률');
    const conditions = [makeLeaf('change_pct_rank')];
    const old = screenerRequestKey({ conditions, universe: {} });
    const explicit = screenerRequestKey({ conditions: [{ ...conditions[0], type: 'change_pct_rank',
      params: { top_n: 100, direction: 'up' } }], universe: {} });
    expect(explicit).toBe(old);
    expect(monitorPeriod([makeLeaf('institution_net_buy_rank'), makeLeaf('volume_rank')], false)).toBe(10_000);
  });

  it.each([
    ['surge', '거래량 급증', '1분 기준 급증률 250.5%'],
    ['volume', '거래량', '당일 거래량 12,345주'],
    ['program', '프로그램', '순매수금액 50억'],
    ['institution', '기관', '장중 추정 순매수금액 50억'],
    ['foreign', '외국인', '장중 추정 순매수금액 50억'],
  ] as const)('shows %s evidence with its units and preserves venue semantics', (kind: MarketRankKind, label, text) => {
    const investor = kind === 'institution' || kind === 'foreign';
    const event: ScreenerOccurrence = { condition_id: kind, condition_key: kind, date: '2026-10-30',
      market_rank_match: { kind, rank: 99, market: 'kosdaq', venue: investor ? null : 'UN',
        quote_venue: investor ? 'UN' : null, fetched_at_ms: Date.parse('2026-10-30T10:20:00+09:00'),
        volume_surge_pct: 250.5, volume: 12345, net_buy_won: 5e9 } };
    const activate = vi.fn();
    render(<div onClick={activate}><MarketRankEvidence row={{ name: '테스트', occurrences: [event] }} /></div>);
    fireEvent.click(screen.getByRole('button', { name: `테스트 ${label} 순위 근거` }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(text);
    expect(dialog).toHaveTextContent('기준일 2026-10-30');
    expect(dialog).toHaveTextContent('10:20:00');
    if (investor) expect(dialog).toHaveTextContent('순위: 거래소 지정 미지원 · 표시 시세: 통합');
    expect(activate).not.toHaveBeenCalled();
  });

  it('keeps both upward and downward evidence accessible on the same row', () => {
    render(<MarketRankEvidence row={{ name: '테스트', occurrences: ['up', 'down'].map((direction, i) => ({
      condition_id: direction, condition_key: direction, date: '2026-10-30', change_pct_rank_match: {
        direction: direction as 'up' | 'down', rank: i + 1, change_pct: i === 0 ? 10 : -20,
        market: 'all', venue: 'KRX', fetched_at_ms: 1 },
    })) }} />);
    expect(screen.getByRole('button', { name: '테스트 등락률 순위 근거' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '테스트 하락률 순위 근거' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('하락률 2위');
    expect(screen.getByRole('dialog')).toHaveTextContent('-20%');
  });
});
