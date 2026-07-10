import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import OrderbookTable from '../../src/sidebar/OrderbookTable';
import type { OrderbookSnapshot } from '../../src/api/types';

const mkSnap = (asks: number[], bids: number[]): OrderbookSnapshot => ({
  ts_ms: 1779062400000,
  seq: 1,
  ask: asks.map((qty, i) => ({ price: 70000 + i * 10, qty })),
  bid: bids.map((qty, i) => ({ price: 70000 - (i + 1) * 10, qty })),
  tot_ask: asks.reduce((a, b) => a + b, 0),
  tot_bid: bids.reduce((a, b) => a + b, 0),
});

describe('OrderbookTable', () => {
  it('renders loading state when snapshot is undefined', () => {
    render(<OrderbookTable snapshot={undefined} />);
    expect(screen.getByText(/로딩 중/)).toBeInTheDocument();
  });

  it('renders ask + bid rows from the ADR-0004 wire shape', () => {
    // SPREAD 구분선 행은 10호가 지표에서 제거됨(#551) — ask/bid 가격 행만 검증한다.
    const snap = mkSnap(
      [100, 200, 150, 80, 60, 40, 30, 25, 20, 15],
      [120, 90, 70, 60, 50, 40, 30, 20, 10, 5],
    );
    render(<OrderbookTable snapshot={snap} />);
    // Best ask price (ask[0])
    expect(screen.getByText('70,000')).toBeInTheDocument();
    // Best bid (bid[0] at 70_000 - 10)
    expect(screen.getByText('69,990')).toBeInTheDocument();
  });

  // ask price = 70000 + i*10 (70000..70090), bid price = 70000 - (i+1)*10 (69990..69900)
  const SNAP = mkSnap(
    [100, 200, 150, 80, 60, 40, 30, 25, 20, 15],
    [120, 90, 70, 60, 50, 40, 30, 20, 10, 5],
  );

  it('전일 종가 기준 색: 위=빨강 / 같음=회색 / 아래=파랑 (baselinePrice 전달)', () => {
    render(<OrderbookTable snapshot={SNAP} baselinePrice={70000} />);
    expect(screen.getByText('70,000')).toHaveClass('text-fg-dim');     // == 전일종가 → 회색
    expect(screen.getByText('70,010')).toHaveClass('text-price-up');   // > → 빨강
    expect(screen.getByText('69,990')).toHaveClass('text-price-down'); // < → 파랑
  });

  it('급등: 매수호가도 전일 종가 위면 빨강 (매도/매수 무관)', () => {
    render(<OrderbookTable snapshot={SNAP} baselinePrice={60000} />); // 모든 호가가 전일종가 위
    expect(screen.getByText('69,990')).toHaveClass('text-price-up');  // bid 인데 위 → 빨강
    expect(screen.getByText('70,000')).toHaveClass('text-price-up');
  });

  it('baselinePrice 미전달/null 이면 매도=빨강·매수=파랑 폴백 (replay 경로)', () => {
    render(<OrderbookTable snapshot={SNAP} />);
    expect(screen.getByText('70,000')).toHaveClass('text-price-up');   // ask 폴백
    expect(screen.getByText('69,990')).toHaveClass('text-price-down'); // bid 폴백
  });
});
