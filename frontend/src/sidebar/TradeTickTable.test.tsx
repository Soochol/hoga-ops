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
    ...overrides,
  };
}

describe('TradeTickTable', () => {
  it('버퍼가 비면 빈 상태를 표시한다', () => {
    render(<TradeTickTable view={{ ticks: [], prevClose: null }} />);
    expect(screen.getByText('체결 데이터 없음')).toBeInTheDocument();
  });

  it('시각·체결가·체결량 3열을 렌더한다 (구분 열 없음)', () => {
    render(<TradeTickTable view={view()} />);
    expect(screen.getByText('09:00:02')).toBeInTheDocument();
    expect(screen.getByText('70,200')).toBeInTheDocument();
    expect(screen.getByText('40')).toBeInTheDocument();
    // 구분 열은 제거됨 — 매수/매도는 체결량 글자색으로만 표현.
    expect(screen.queryByText('구분')).not.toBeInTheDocument();
    expect(screen.queryByText('매수')).not.toBeInTheDocument();
    expect(screen.queryByText('매도')).not.toBeInTheDocument();
  });

  it('최신 체결이 DOM 상에서 위에 온다', () => {
    render(<TradeTickTable view={view()} />);
    const times = screen.getAllByText(/^09:00:0\d$/).map((el) => el.textContent);
    expect(times).toEqual(['09:00:02', '09:00:01']);
  });

  it('체결량 글자색이 매수/매도 방향을 표현한다', () => {
    render(<TradeTickTable view={view()} />);
    expect(screen.getByText('40')).toHaveClass('text-price-up');   // side +1 매수
    expect(screen.getByText('10')).toHaveClass('text-price-down'); // side -1 매도
  });

  it('side==0 (동시호가·장전) 체결량은 중립색이다', () => {
    render(
      <TradeTickTable
        view={{
          ticks: [{ tMs: OPEN_MS, price: 70000, qty: 5, side: 0, key: 'k0' }],
          prevClose: 70000,
        }}
      />,
    );
    expect(screen.getByText('5')).toHaveClass('text-fg-dim');
  });

  // KRX 컨벤션: 체결가 색 기준은 매수/매도가 아니라 **전일 종가 대비**다. 매도
  // 체결이라도 전일 종가보다 높으면 빨강 — OrderbookTable 과 같은 규칙.
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

  // 회귀 가드: 수량 비율 깊이 막대는 제거됐다. 설정으로 끌 수 없는 상시 배경이라
  // 사용자 지정 강조색과 섞였고, 정규화 기준(표시 버퍼 최댓값)이 틱마다 흔들렸다.
  it('수량 비율 깊이 막대를 렌더하지 않는다', () => {
    const { container } = render(<TradeTickTable view={view()} />);
    expect(container.querySelector('span[style*="width"]')).toBeNull();
  });

  it('강조가 꺼지면 어떤 셀에도 배경을 칠하지 않는다', () => {
    const { container } = render(<TradeTickTable view={view()} highlight={null} />);
    expect(container.querySelector('span[style*="background"]')).toBeNull();
  });

  describe('대량 체결 강조', () => {
    // 70,200 × 40 = 2,808,000원 / 70,100 × 10 = 701,000원.
    it('체결가 × 체결량이 임계값 이상인 행의 체결량 칸만 배경을 칠한다', () => {
      render(
        <TradeTickTable
          view={view()}
          highlight={{ thresholdWon: 1_000_000, color: '#EAB308' }}
        />,
      );
      const highlighted = screen.getAllByTestId('trade-qty-highlighted');
      expect(highlighted).toHaveLength(1);
      expect(highlighted[0]).toHaveTextContent('40');
      // 저장 색(6자리 hex)에 알파를 얹어 칠한다 — 불투명 배경은 글자색을 잡아먹는다.
      expect(highlighted[0].style.background.length).toBeGreaterThan(0);
    });

    it('임계값 경계(정확히 같은 금액)는 강조한다 (이상 = inclusive)', () => {
      render(
        <TradeTickTable
          view={view()}
          highlight={{ thresholdWon: 70_200 * 40, color: '#EAB308' }}
        />,
      );
      expect(screen.getAllByTestId('trade-qty-highlighted')).toHaveLength(1);
    });

    it('highlight=null (설정 토글 OFF) 이면 아무 행도 강조하지 않는다', () => {
      render(<TradeTickTable view={view()} highlight={null} />);
      expect(screen.queryByTestId('trade-qty-highlighted')).not.toBeInTheDocument();
    });

    it('모든 행이 임계값 미만이면 강조 없음', () => {
      render(
        <TradeTickTable
          view={view()}
          highlight={{ thresholdWon: 100_000_000, color: '#EAB308' }}
        />,
      );
      expect(screen.queryByTestId('trade-qty-highlighted')).not.toBeInTheDocument();
    });
  });
});
