import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { QuoteRow } from './QuoteRow';

function row(props: Partial<React.ComponentProps<typeof QuoteRow>> = {}) {
  const onClick = vi.fn();
  render(
    <ul>
      <QuoteRow name="삼성전자" price={72400} pct={1.2} changeWon={750}
        active={false} ariaLabel="삼성전자 005930 차트 열기"
        testId="quote-row-005930" onClick={onClick} {...props} />
    </ul>,
  );
  return { onClick };
}

describe('QuoteRow', () => {
  it('renders name, price (ko-KR, 원), and 전일대비 등락액 + %', () => {
    row();
    expect(screen.getByText('삼성전자')).toBeInTheDocument();
    expect(screen.getByText('72,400원')).toBeInTheDocument();
    expect(screen.getByText('+750원 (1.20%)')).toBeInTheDocument();
  });

  it('renders — for null change (장전/무데이터)', () => {
    row({ pct: null, changeWon: null });
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

  it('applies dragging styles, forwards the sortable ref, and still fires onClick', () => {
    const setRef = vi.fn();
    const { onClick } = row({ dragging: true, sortableRef: setRef });
    const li = screen.getByTestId('quote-row-005930');
    expect(li.style.opacity).toBe('0.6');
    expect(li.style.cursor).toBe('grabbing');
    expect(setRef).toHaveBeenCalledWith(li);
    fireEvent.click(li);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('right-click calls onContextMenu', () => {
    const onContextMenu = vi.fn();
    row({ onContextMenu });
    fireEvent.contextMenu(screen.getByTestId('quote-row-005930'));
    expect(onContextMenu).toHaveBeenCalledOnce();
  });

  it('Delete key on the focused row calls onDelete (not onClick)', () => {
    const onDelete = vi.fn();
    const { onClick } = row({ onDelete });
    fireEvent.keyDown(screen.getByTestId('quote-row-005930'), { key: 'Delete' });
    expect(onDelete).toHaveBeenCalledOnce();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('Enter still triggers onClick when onDelete is provided', () => {
    const onDelete = vi.fn();
    const { onClick } = row({ onDelete });
    fireEvent.keyDown(screen.getByTestId('quote-row-005930'), { key: 'Enter' });
    expect(onClick).toHaveBeenCalledOnce();
    expect(onDelete).not.toHaveBeenCalled();
  });
});
