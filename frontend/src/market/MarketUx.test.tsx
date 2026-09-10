import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '../api/client';
import { FundsCard, RankCard, SectorCard } from './MarketPage';
import { ChartProbe } from './ChartProbe';
import { DataStamp } from './marketCardBits';
import { fundChange } from './marketFormat';

function mount(node: React.ReactNode) {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={query}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>);
}

beforeEach(() => vi.restoreAllMocks());

describe('market data meaning', () => {
  it('never uses the fetch date as the trading date', () => {
    render(<DataStamp fetchedAt={Date.parse('2026-09-08T16:00:00Z')} />);
    expect(screen.getByText('기준일 미제공')).toBeInTheDocument();
    expect(screen.getByText(/조회$/)).toHaveTextContent('09. 09. 01:00');
    expect(screen.queryByText('09/09 기준')).not.toBeInTheDocument();
  });

  it('renders value ranking amounts instead of disguising prices as amounts', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      rows: [{ rank: 1, code: '005930', name: '삼성전자', price: 71200, change_pct: 5.79, trade_value_won: 3_119_200_000_000 }],
      market_open: false, fetched_at_ms: 1, venue: 'KRX', warnings: ['etf_filter_unavailable'],
    });
    mount(<RankCard title="거래대금 상위" kind="value" direction="up" />);
    expect(await screen.findByText('31,192')).toBeInTheDocument();
    expect(screen.queryByText('71,200')).not.toBeInTheDocument();
    expect(screen.getByText(/필터 확인 필요/)).toBeInTheDocument();
    expect(screen.getByText('장 외')).toBeInTheDocument();
  });

  it('missing trade value stays absent, rather than falling back to price', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      rows: [{ rank: 1, code: '005930', name: '삼성전자', price: 71200, change_pct: 0, trade_value_won: null }],
      market_open: true, fetched_at_ms: 1,
    });
    mount(<RankCard title="거래대금 상위" kind="value" direction="up" />);
    expect(await screen.findByRole('button', { name: /삼성전자/ })).toHaveTextContent('—');
  });

  it('distinguishes fund balance from change and leaves missing ending values unknown', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue({ as_of: '20260904', series: [
      { date: '20260901', deposit_won: 100e12, credit_won: null, cma_won: 80e12 },
      { date: '20260903', deposit_won: 98e12, credit_won: 30e12, cma_won: 82e12 },
      { date: '20260904', deposit_won: 93.5e12, credit_won: 31e12, cma_won: null },
    ] });
    mount(<FundsCard />);
    expect(await screen.findByText('93.5조')).toBeInTheDocument();
    expect(screen.getByText('-6.5조')).toBeInTheDocument();
    expect(screen.getByText('+1.0조')).toBeInTheDocument();
    expect(fundChange([80e12, 82e12, null])).toBeNull();
    expect(fundChange([null, null])).toBeNull();
  });

  it('sorts all sectors before truncating and keeps missing values last', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue({ markets: { '0': { sectors: [
      ...Array.from({ length: 12 }, (_, i) => ({ code: String(i), name: `업종${i}`, change_pct: i === 0 ? null : -i })),
      { code: '99', name: '최대상승', change_pct: 20 },
    ] } } });
    mount(<SectorCard />);
    await screen.findByText('업종0');
    expect(screen.queryByText('최대상승')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '상승순' }));
    expect(screen.getByText('최대상승')).toBeInTheDocument();
    expect(screen.queryByText('업종0')).not.toBeInTheDocument();
  });
});

it('chart inspection is keyboard accessible and resets after Escape', async () => {
  render(<ChartProbe labels={['09/01', '09/02']} summaries={['외국인 +10억', '외국인 -20억']} />);
  const chart = screen.getByRole('group');
  fireEvent.focus(chart);
  expect(within(screen.getByRole('status')).getByText('09/02')).toBeInTheDocument();
  fireEvent.keyDown(chart, { key: 'ArrowLeft' });
  expect(screen.getByRole('status')).toHaveTextContent('09/01 · 외국인 +10억');
  fireEvent.keyDown(chart, { key: 'End' });
  expect(screen.getByRole('status')).toHaveTextContent('09/02');
  fireEvent.keyDown(chart, { key: 'Escape' });
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

it('separates verified industries, index products and unknown codes without dropping rows', async () => {
  vi.spyOn(client, 'apiCall').mockResolvedValue({ markets: { '0': { sectors: [
    { code: '005', name: '음식료', change_pct: 1 },
    { code: '604', name: '고배당50', change_pct: 2 },
    { code: '9999', name: '신규 코드', change_pct: 3 },
  ] } } });
  mount(<SectorCard />);
  await screen.findByText('음식료');
  await userEvent.click(screen.getByRole('button', { name: '업종' }));
  expect(screen.getByText('음식료')).toBeInTheDocument();
  expect(screen.queryByText('고배당50')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '규모·대표지수' }));
  expect(screen.getByText('고배당50')).toBeInTheDocument();
  expect(screen.queryByText('음식료')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '미분류' }));
  expect(screen.getByText('신규 코드')).toBeInTheDocument();
});

it('reports failed refreshes separately from unknown trading dates', () => {
  render(<DataStamp fetchedAt={1} error />);
  expect(screen.getByRole('status')).toHaveTextContent('서버 연결 확인 필요 · 마지막 데이터 유지');
  expect(screen.getByText('기준일 미제공')).toBeInTheDocument();
});

it('does not show a nearby sample as an observation inside a failed interval', () => {
  render(<ChartProbe labels={['09:00', '10:00']} summaries={['개인 +10억원', '개인 +20억원']}
    positions={[0, 1]} unavailableRanges={[{ start: 0.25, end: 0.75 }]} />);
  const chart = screen.getByRole('group');
  vi.spyOn(chart, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, width: 100, height: 100, top: 0, left: 0, right: 100, bottom: 100, toJSON: () => ({}) });
  fireEvent.pointerMove(chart, { clientX: 50 });
  expect(screen.getByRole('status')).toHaveTextContent('수신 실패 구간 · 관측값 없음');
  fireEvent.keyDown(chart, { key: 'Home' });
  expect(screen.getByRole('status')).toHaveTextContent('09:00 · 개인 +10억원');
});
