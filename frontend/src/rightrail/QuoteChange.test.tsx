import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QuoteChange } from './QuoteChange';

describe('QuoteChange', () => {
  it('상승: +등락액(원) + 절대값 등락률, KRX 빨강(--price-up)', () => {
    render(<QuoteChange won={750} pct={1.2} />);
    const el = screen.getByText('+750원 (1.20%)');
    expect(el).toBeInTheDocument();
    expect(el).toHaveClass('text-price-up');
  });

  it('하락: 음수 등락액 + 절대값 등락률, KRX 파랑(--price-down)', () => {
    render(<QuoteChange won={-1500} pct={-0.8} />);
    const el = screen.getByText('-1,500원 (0.80%)');
    expect(el).toBeInTheDocument();
    expect(el).toHaveClass('text-price-down');
  });

  it('보합: 0원 (0.00%), 중립', () => {
    render(<QuoteChange won={0} pct={0} />);
    const el = screen.getByText('0원 (0.00%)');
    expect(el).toBeInTheDocument();
    expect(el).toHaveClass('text-fg-dim');
  });

  it('천 단위 구분 + 부호 (큰 등락액)', () => {
    render(<QuoteChange won={12300} pct={3.4} />);
    expect(screen.getByText('+12,300원 (3.40%)')).toBeInTheDocument();
  });

  it('등락액 없음(스크리너 코퍼스 폴백) → 등락률만', () => {
    render(<QuoteChange won={null} pct={2.96} />);
    expect(screen.getByText('+2.96%')).toBeInTheDocument();
  });

  it('등락액·등락률 모두 null(장전/무데이터) → —', () => {
    render(<QuoteChange won={null} pct={null} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
