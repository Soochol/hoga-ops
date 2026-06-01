import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { QuoteRow } from './QuoteRow';

function row(props: Partial<React.ComponentProps<typeof QuoteRow>> = {}) {
  const onClick = vi.fn();
  render(
    <ul>
      <QuoteRow code="005930" name="삼성전자" price={72400} pct={1.2}
        active={false} ariaLabel="삼성전자 005930 차트 열기"
        testId="quote-row-005930" onClick={onClick} {...props} />
    </ul>,
  );
  return { onClick };
}

describe('QuoteRow', () => {
  it('renders code, name, price (ko-KR), and signed change %', () => {
    row();
    expect(screen.getByText('005930')).toBeInTheDocument();
    expect(screen.getByText('삼성전자')).toBeInTheDocument();
    expect(screen.getByText('72,400')).toBeInTheDocument();
    expect(screen.getByText(/\+1\.20%/)).toBeInTheDocument();
  });

  it('renders — for null pct (장전/무데이터)', () => {
    row({ pct: null });
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('Enter key triggers onClick (keyboard a11y)', () => {
    const { onClick } = row();
    fireEvent.keyDown(screen.getByTestId('quote-row-005930'), { key: 'Enter' });
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('renders no trailing cell when trailingAction is omitted (backward compat)', () => {
    row();
    expect(within(screen.getByTestId('quote-row-005930')).queryByRole('button')).toBeNull();
  });

  it('renders the trailingAction node when provided', () => {
    row({ trailingAction: <button data-testid="act">x</button> });
    expect(within(screen.getByTestId('quote-row-005930')).getByTestId('act')).toBeInTheDocument();
  });

  it('Enter on the trailing action does NOT trigger the row onClick (keyboard isolation)', () => {
    const { onClick } = row({ trailingAction: <button data-testid="act">x</button> });
    fireEvent.keyDown(screen.getByTestId('act'), { key: 'Enter' });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('Enter on the row itself still triggers onClick', () => {
    const { onClick } = row({ trailingAction: <button data-testid="act">x</button> });
    fireEvent.keyDown(screen.getByTestId('quote-row-005930'), { key: 'Enter' });
    expect(onClick).toHaveBeenCalledOnce();
  });
});
