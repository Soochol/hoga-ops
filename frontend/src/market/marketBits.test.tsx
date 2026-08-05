/** 시장 종합 그리기 조각 — 목업이 감추던 "없음" 의 처리를 고정한다 (#1102). */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AdvanceDeclineBar, BreadthTile, PctText, Sparkline } from './marketBits';
import { fmtSigned, wonToJo } from './marketFormat';

describe('PctText', () => {
  it('값이 없으면 0 이 아니라 —', () => {
    render(<PctText pct={null} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('부호와 방향색을 함께 준다 (색약 보조 2중)', () => {
    const { container } = render(<PctText pct={1.61} />);
    expect(screen.getByText('+1.61%')).toBeInTheDocument();
    expect(container.querySelector('.text-price-up')).not.toBeNull();
  });
});

describe('AdvanceDeclineBar', () => {
  it('종합지수면 그린다', () => {
    const { container } = render(<AdvanceDeclineBar rising={742} falling={141} flat={31} />);
    expect(container.querySelector('div')).not.toBeNull();
  });

  it('지수 상품은 **부재가 정상**이라 아무것도 그리지 않는다 (#1100)', () => {
    const { container } = render(<AdvanceDeclineBar rising={null} falling={null} flat={null} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('BreadthTile', () => {
  it('절사되면 카운트가 하한임을 + 로 말한다 (#1099)', () => {
    render(<BreadthTile label="급등" count={1000} truncated dir="up" />);
    expect(screen.getByText('1,000+')).toBeInTheDocument();
  });

  it('절사가 아니면 + 를 붙이지 않는다', () => {
    render(<BreadthTile label="52주 신고" count={45} dir="up" />);
    expect(screen.getByText('45')).toBeInTheDocument();
  });

  it('값이 없으면 0 이 아니라 —', () => {
    render(<BreadthTile label="급락" count={null} dir="down" />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});

describe('포맷터', () => {
  it('fmtSigned 는 null 을 0 으로 채우지 않는다', () => {
    expect(fmtSigned(null)).toBe('—');
    expect(fmtSigned(1234)).toBe('+1,234');
    expect(fmtSigned(-1234)).toBe('-1,234');
  });

  it('wonToJo 는 원(raw)을 조로 — KOFIA 는 원으로 준다 (#1098)', () => {
    expect(wonToJo(102825552619394)).toBeCloseTo(102.83, 1);
    expect(wonToJo(null)).toBeNull();
  });
});

describe('Sparkline', () => {
  it('점이 2개 미만이면 그리지 않는다 — 한 점짜리 선은 거짓 정보다', () => {
    const { container: c0 } = render(<Sparkline points={[]} />);
    const { container: c1 } = render(<Sparkline points={[100]} />);
    expect(c0.firstChild).toBeNull();
    expect(c1.firstChild).toBeNull();
  });

  it('시작→끝 방향으로 색이 갈린다', () => {
    const { container: up } = render(<Sparkline points={[100, 110]} />);
    const { container: down } = render(<Sparkline points={[110, 100]} />);
    expect(up.querySelector('path')?.getAttribute('stroke')).toBe('var(--price-up)');
    expect(down.querySelector('path')?.getAttribute('stroke')).toBe('var(--price-down)');
  });
});

describe('Sparkline 색 기준 (DESIGN.md CandleGlyph 규칙)', () => {
  it('baseline(당일 시가) 기준이라 큰 숫자와 색이 갈릴 수 있다 — 그게 의도다', () => {
    // 시가 120 → 현재 110: 장중은 하락(파랑). 전일 종가가 100 이었다면 숫자는 상승(빨강).
    const { container } = render(<Sparkline points={[118, 110]} baseline={120} />);
    expect(container.querySelector('path')?.getAttribute('stroke')).toBe('var(--price-down)');
  });

  it('baseline 이 없으면 첫 점을 쓴다', () => {
    const { container } = render(<Sparkline points={[100, 110]} />);
    expect(container.querySelector('path')?.getAttribute('stroke')).toBe('var(--price-up)');
  });
});
