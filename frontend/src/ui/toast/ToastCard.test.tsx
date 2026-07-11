import { act, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { ToastCard } from './ToastCard';

// jsdom 엔 matchMedia 폴리필이 없어 prefersReducedMotion()===true → 애니메이션
// 지연 없이 즉시 마운트/언마운트된다(모션은 실제 브라우저에서만 검증).

describe('ToastCard', () => {
  it('renders as a button when onClick is given and fires it', () => {
    let clicked = 0;
    render(
      <ToastCard visible variant="neutral" ariaLabel="열기" onClick={() => { clicked += 1; }}>
        <span>본문</span>
      </ToastCard>,
    );
    const btn = screen.getByRole('button', { name: '열기' });
    expect(btn).toHaveClass('toast-card', 'border-border');
    act(() => btn.click());
    expect(clicked).toBe(1);
  });

  it('renders as a div with the given role and warn border', () => {
    render(
      <ToastCard visible variant="warn" role="status">
        <span>경고</span>
      </ToastCard>,
    );
    const card = screen.getByRole('status');
    expect(card.tagName).toBe('DIV');
    expect(card).toHaveClass('border-warn');
  });

  it('unmounts and calls onExited when visible flips false (reduced motion → instant)', () => {
    let exited = 0;
    function Harness() {
      const [visible, setVisible] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setVisible(false)}>hide</button>
          <ToastCard visible={visible} role="status" onExited={() => { exited += 1; }}>
            <span>본문</span>
          </ToastCard>
        </>
      );
    }
    render(<Harness />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    act(() => screen.getByRole('button', { name: 'hide' }).click());
    expect(screen.queryByRole('status')).toBeNull();
    expect(exited).toBe(1);
  });

  it('renders an action button (div variant) and fires it without card-level button nesting', () => {
    let undone = 0;
    render(
      <ToastCard visible role="status" action={{ label: '실행취소', onClick: () => { undone += 1; } }}>
        <span>그림 2개 삭제됨</span>
      </ToastCard>,
    );
    // action ⇒ div variant (no card-wide button), single inner action button.
    const card = screen.getByRole('status');
    expect(card.tagName).toBe('DIV');
    const btn = screen.getByRole('button', { name: '실행취소' });
    act(() => btn.click());
    expect(undone).toBe(1);
  });

  it('renders a progress bar only when progress is provided', () => {
    const { rerender } = render(
      <ToastCard visible role="status" progress={{ durationMs: 5000, paused: false }}>
        <span>본문</span>
      </ToastCard>,
    );
    expect(screen.getByRole('status').querySelector('.toast-progress')).not.toBeNull();

    rerender(
      <ToastCard visible role="status" progress={null}>
        <span>본문</span>
      </ToastCard>,
    );
    expect(screen.getByRole('status').querySelector('.toast-progress')).toBeNull();
  });
});
