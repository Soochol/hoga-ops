import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import TradeTickTable from './TradeTickTable';
import type { TradeTickView } from '../live/tradeTicks';

// 2026-07-20 09:00:00 KST
const OPEN_MS = 1784505600000;

function view(overrides: Partial<TradeTickView> = {}): TradeTickView {
  return {
    ticks: [
      { tMs: OPEN_MS + 2000, price: 70200, qty: 40, side: 1, key: 'k2' },
      { tMs: OPEN_MS + 1000, price: 70100, qty: 10, side: -1, key: 'k1' },
    ],
    prevClose: 70000,
    maxQty: 40,
    ...overrides,
  };
}

describe('TradeTickTable', () => {
  it('버퍼가 비면 빈 상태를 표시한다', () => {
    render(<TradeTickTable view={{ ticks: [], prevClose: null, maxQty: 0 }} />);
    expect(screen.getByText('체결 데이터 없음')).toBeInTheDocument();
  });

  it('시각·체결가·체결량·구분 4열을 렌더한다', () => {
    render(<TradeTickTable view={view()} />);
    expect(screen.getByText('09:00:02')).toBeInTheDocument();
    expect(screen.getByText('70,200')).toBeInTheDocument();
    expect(screen.getByText('40')).toBeInTheDocument();
    expect(screen.getByText('매수')).toBeInTheDocument();
    expect(screen.getByText('매도')).toBeInTheDocument();
  });

  it('최신 체결이 DOM 상에서 위에 온다', () => {
    render(<TradeTickTable view={view()} />);
    const times = screen.getAllByText(/^09:00:0\d$/).map((el) => el.textContent);
    expect(times).toEqual(['09:00:02', '09:00:01']);
  });

  // KRX 컨벤션: 색 기준은 매수/매도가 아니라 **전일 종가 대비**다. 매도 체결이라도
  // 전일 종가보다 높으면 빨강 — OrderbookTable 과 같은 규칙이라 나란히 놓아도 안 어긋난다.
  it('체결가 색은 전일 종가 대비 방향을 따른다 (매도 체결이어도 상승이면 빨강)', () => {
    render(<TradeTickTable view={view({ prevClose: 70000 })} />);
    expect(screen.getByText('70,100')).toHaveClass('text-price-up');
  });

  it('전일 종가보다 낮은 체결가는 파랑', () => {
    render(<TradeTickTable view={view({ prevClose: 70500 })} />);
    expect(screen.getByText('70,200')).toHaveClass('text-price-down');
  });

  it('전일 종가를 모르면 매수/매도 구분색으로 폴백한다', () => {
    render(<TradeTickTable view={view({ prevClose: null })} />);
    expect(screen.getByText('70,200')).toHaveClass('text-price-up');   // side +1
    expect(screen.getByText('70,100')).toHaveClass('text-price-down'); // side -1
  });

  it('side==0 (동시호가·장전) 은 중립 기호로 표기한다', () => {
    render(
      <TradeTickTable
        view={{
          ticks: [{ tMs: OPEN_MS, price: 70000, qty: 5, side: 0, key: 'k0' }],
          prevClose: 70000,
          maxQty: 5,
        }}
      />,
    );
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('깊이 막대는 표시 구간 최대 체결량 대비 비율이다', () => {
    const { container } = render(<TradeTickTable view={view()} />);
    const bars = container.querySelectorAll('span[style*="width"]');
    expect(bars[0]).toHaveStyle({ width: '100%' }); // qty 40 = maxQty
    expect(bars[1]).toHaveStyle({ width: '25%' });  // qty 10 / 40
  });

  it('maxQty 가 0 이어도 (방어) 막대 폭 계산이 NaN 으로 새지 않는다', () => {
    const { container } = render(
      <TradeTickTable
        view={{
          ticks: [{ tMs: OPEN_MS, price: 70000, qty: 5, side: 1, key: 'k0' }],
          prevClose: null,
          maxQty: 0,
        }}
      />,
    );
    expect(container.querySelector('span[style*="width"]')).toHaveStyle({ width: '0%' });
  });
});
