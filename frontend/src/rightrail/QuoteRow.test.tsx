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
  it('renders name, neutral price (no 원), and colored percent as separate columns', () => {
    row();
    expect(screen.getByText('삼성전자')).toBeInTheDocument();
    // 원 접미사 제거 + 가격/% 분리 컬럼.
    expect(screen.getByText('72,400')).toBeInTheDocument();
    expect(screen.getByText('+1.20%')).toBeInTheDocument();
    expect(screen.queryByText('72,400원 (+1.20%)')).not.toBeInTheDocument();
  });

  it('shows an empty percent column when price exists but pct is missing', () => {
    row({ pct: null, changeWon: null });
    expect(screen.getByText('72,400')).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it('renders — when price is missing', () => {
    row({ price: null, pct: null, changeWon: null });
    expect(screen.getByText('—')).toBeInTheDocument();
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
    expect(li.style.opacity).toBe('0.72');
    expect(li.style.cursor).toBe('grabbing');
    expect(li.style.background).toContain('color-mix');
    expect(li.style.boxShadow).not.toContain('var(--accent)');
    expect(li.className).not.toContain('before:bg-[var(--accent)]');
    expect(li.className).not.toContain('after:bg-[var(--accent)]');
    expect(setRef).toHaveBeenCalledWith(li);
    fireEvent.click(li);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('renders one insertion line between rows when dropIndicator is provided', () => {
    row({ dropIndicator: 'after' });
    const li = screen.getByTestId('quote-row-005930');

    expect(li.className).toContain('after:bg-[var(--accent)]');
    expect(li.className).toContain('after:bottom-0');
    expect(li.className).toContain('before:border-[var(--accent)]');
    expect(li.className).not.toContain('after:top-0');
  });

  it('puts drag listeners on the whole row without rendering a handle', () => {
    const onPointerDown = vi.fn();
    const setActivatorNodeRef = vi.fn();
    const { onClick } = row({
      dragListeners: { onPointerDown } as ComponentProps<typeof QuoteRow>['dragListeners'],
      dragAttributes: { role: 'button' } as ComponentProps<typeof QuoteRow>['dragAttributes'],
      dragActivatorRef: setActivatorNodeRef,
    });
    const li = screen.getByTestId('quote-row-005930');

    expect(screen.queryByTestId('drag-handle-quote-row-005930')).not.toBeInTheDocument();
    expect(setActivatorNodeRef).toHaveBeenCalledWith(li);
    fireEvent.pointerDown(li);
    expect(onPointerDown).toHaveBeenCalledOnce();

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

  it('ArrowDown/ArrowUp move focus to the adjacent row and select it instantly', () => {
    const onA = vi.fn();
    const onB = vi.fn();
    render(
      <ul>
        <QuoteRow name="A" price={1} pct={null} changeWon={null} active={false}
          ariaLabel="A" testId="row-a" onClick={onA} />
        <QuoteRow name="B" price={2} pct={null} changeWon={null} active={false}
          ariaLabel="B" testId="row-b" onClick={onB} />
      </ul>,
    );
    const a = screen.getByTestId('row-a');
    const b = screen.getByTestId('row-b');
    a.focus();
    fireEvent.keyDown(a, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(b);
    // 이동 즉시 선택 = 이웃 행의 onClick(현재 탭) 발동
    expect(onB).toHaveBeenCalledWith({ disposition: 'current-tab' });

    fireEvent.keyDown(b, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(a);
    expect(onA).toHaveBeenCalledWith({ disposition: 'current-tab' });
  });

  it('ArrowDown at the last row is a no-op (no wrap-around)', () => {
    const onB = vi.fn();
    render(
      <ul>
        <QuoteRow name="A" price={1} pct={null} changeWon={null} active={false}
          ariaLabel="A" testId="row-a" onClick={vi.fn()} />
        <QuoteRow name="B" price={2} pct={null} changeWon={null} active={false}
          ariaLabel="B" testId="row-b" onClick={onB} />
      </ul>,
    );
    const b = screen.getByTestId('row-b');
    b.focus();
    fireEvent.keyDown(b, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(b); // 마지막 행에서 멈춤
    expect(onB).not.toHaveBeenCalled();
  });

  it('Arrow navigation crosses <ul> group boundaries within [data-quote-nav]', () => {
    const onB = vi.fn();
    render(
      <div data-quote-nav="">
        <ul>
          <QuoteRow name="A" price={1} pct={null} changeWon={null} active={false}
            ariaLabel="A" testId="row-a" onClick={vi.fn()} />
        </ul>
        <ul>
          <QuoteRow name="B" price={2} pct={null} changeWon={null} active={false}
            ariaLabel="B" testId="row-b" onClick={onB} />
        </ul>
      </div>,
    );
    const a = screen.getByTestId('row-a');
    a.focus();
    fireEvent.keyDown(a, { key: 'ArrowDown' });
    // 폴더별 <ul>이 나뉘어도 data-quote-nav 스코프 안이면 다음 그룹 첫 행으로 넘어간다
    expect(document.activeElement).toBe(screen.getByTestId('row-b'));
    expect(onB).toHaveBeenCalledOnce();
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
