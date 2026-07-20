import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import OrderbookTable from './OrderbookTable';
import type { OrderbookSnapshot } from '../api/types';
import type { OrderbookDeltaBadges } from './orderbookDeltaBadges';

const snapshot: OrderbookSnapshot = {
  ts_ms: 0,
  seq: 0,
  ask: Array.from({ length: 10 }, (_, i) => ({ price: 1000 + i * 10, qty: 100 })),
  bid: Array.from({ length: 10 }, (_, i) => ({ price: 990 - i * 10, qty: 100 })),
  tot_ask: 1000,
  tot_bid: 1000,
};

afterEach(cleanup);

describe('OrderbookTable 증감 뱃지', () => {
  it('뱃지 맵의 단에만 부호 붙은 증감이 렌더된다', () => {
    const badges: OrderbookDeltaBadges = new Map([
      ['a:1000', { delta: 1200, atMs: 1 }],
      ['b:990', { delta: -800, atMs: 1 }],
    ]);
    render(<OrderbookTable snapshot={snapshot} deltaBadges={badges} />);
    expect(screen.getByText('+1,200')).toBeInTheDocument();
    expect(screen.getByText('−800')).toBeInTheDocument();
    // 다른 단에는 뱃지 없음.
    expect(screen.queryAllByText(/^[+−]/)).toHaveLength(2);
  });

  it('deltaBadges 미전달(스팟·replay)이면 뱃지가 전혀 없다', () => {
    render(<OrderbookTable snapshot={snapshot} />);
    expect(screen.queryAllByText(/^[+−]/)).toHaveLength(0);
  });
});
