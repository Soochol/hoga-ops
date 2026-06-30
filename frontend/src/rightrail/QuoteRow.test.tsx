import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { QuoteRow } from './QuoteRow';

function row(props: Partial<ComponentProps<typeof QuoteRow>> = {}) {
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
  it('renders name and price plus change percent on one line', () => {
    row();
    expect(screen.getByText('삼성전자')).toBeInTheDocument();
    expect(screen.getByText('72,400원 (+1.20%)')).toBeInTheDocument();
    expect(screen.queryByText('+750원 (1.20%)')).not.toBeInTheDocument();
  });

  it('renders — for null change (장전/무데이터)', () => {
    row({ pct: null, changeWon: null });
    expect(screen.getByText('72,400원 (—)')).toBeInTheDocument();
  });

  it('Enter key triggers onClick (keyboard a11y)', () => {
    const { onClick } = row();
    fireEvent.keyDown(screen.getByTestId('quote-row-005930'), { key: 'Enter' });
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('plain click opens in the current tab', () => {
    const { onClick } = row();
    fireEvent.click(screen.getByTestId('quote-row-005930'));
    expect(onClick).toHaveBeenCalledWith({ disposition: 'current-tab' });
  });

  it('Ctrl-click and Meta-click request a new tab', () => {
    const { onClick } = row();
    const li = screen.getByTestId('quote-row-005930');
    fireEvent.click(li, { ctrlKey: true });
    fireEvent.click(li, { metaKey: true });
    expect(onClick).toHaveBeenNthCalledWith(1, { disposition: 'new-tab' });
    expect(onClick).toHaveBeenNthCalledWith(2, { disposition: 'new-tab' });
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

  it('puts drag listeners on the left handle without stealing row clicks', () => {
    const onPointerDown = vi.fn();
    const { onClick } = row({
      dragListeners: { onPointerDown } as ComponentProps<typeof QuoteRow>['dragListeners'],
      dragAttributes: { role: 'button' } as ComponentProps<typeof QuoteRow>['dragAttributes'],
    });
    const li = screen.getByTestId('quote-row-005930');
    const handle = screen.getByTestId('drag-handle-quote-row-005930');

    expect(handle).toHaveAttribute('aria-label', '삼성전자 순서 이동');
    fireEvent.pointerDown(handle);
    expect(onPointerDown).toHaveBeenCalledOnce();

    fireEvent.click(handle);
    expect(onClick).not.toHaveBeenCalled();

    fireEvent.click(li);
    expect(onClick).toHaveBeenCalledWith({ disposition: 'current-tab' });
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

  it('Backspace does NOT delete (only Delete is destructive)', () => {
    const onDelete = vi.fn();
    const { onClick } = row({ onDelete });
    fireEvent.keyDown(screen.getByTestId('quote-row-005930'), { key: 'Backspace' });
    expect(onDelete).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('advertises aria-keyshortcuts="Delete" only when onDelete is wired', () => {
    const { unmount } = render(
      <ul><QuoteRow name="삼성전자" price={1} pct={null} changeWon={null} active={false}
        ariaLabel="a" testId="kbd-no" onClick={vi.fn()} /></ul>,
    );
    expect(screen.getByTestId('kbd-no').getAttribute('aria-keyshortcuts')).toBeNull();
    unmount();
    render(
      <ul><QuoteRow name="삼성전자" price={1} pct={null} changeWon={null} active={false}
        ariaLabel="a" testId="kbd-yes" onClick={vi.fn()} onDelete={vi.fn()} /></ul>,
    );
    expect(screen.getByTestId('kbd-yes').getAttribute('aria-keyshortcuts')).toBe('Delete');
  });

  it('moves focus to the sibling row before Delete removes the focused row', () => {
    const onDelete = vi.fn();
    render(
      <ul>
        <QuoteRow name="A" price={1} pct={null} changeWon={null} active={false}
          ariaLabel="A" testId="row-a" onClick={vi.fn()} onDelete={onDelete} />
        <QuoteRow name="B" price={2} pct={null} changeWon={null} active={false}
          ariaLabel="B" testId="row-b" onClick={vi.fn()} onDelete={vi.fn()} />
      </ul>,
    );
    const a = screen.getByTestId('row-a');
    a.focus();
    fireEvent.keyDown(a, { key: 'Delete' });
    expect(onDelete).toHaveBeenCalledOnce();
    // focus handed to the next sibling so it won't fall to <body> on unmount
    expect(document.activeElement).toBe(screen.getByTestId('row-b'));
  });
});
