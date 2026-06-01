import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WatchlistToggleButton } from './WatchlistToggleButton';

describe('WatchlistToggleButton', () => {
  it('non-member: outline heart, "관심종목 추가", aria-pressed=false', () => {
    render(<WatchlistToggleButton isMember={false} onToggle={() => {}} />);
    const btn = screen.getByRole('button', { name: '관심종목 추가' });
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.querySelector('svg')?.getAttribute('fill')).toBe('none');
  });

  it('member: filled heart, "관심종목 해제", aria-pressed=true', () => {
    render(<WatchlistToggleButton isMember onToggle={() => {}} />);
    const btn = screen.getByRole('button', { name: '관심종목 해제' });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.querySelector('svg')?.getAttribute('fill')).toBe('currentColor');
  });

  it('click calls onToggle and stops propagation to the parent row', () => {
    const onToggle = vi.fn();
    const onRowClick = vi.fn();
    render(
      <div onClick={onRowClick}>
        <WatchlistToggleButton isMember={false} onToggle={onToggle} />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: '관심종목 추가' }));
    expect(onToggle).toHaveBeenCalledOnce();
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('variant="row" applies the group-hover reveal classes (초저대비)', () => {
    render(<WatchlistToggleButton isMember={false} onToggle={() => {}} variant="row" />);
    const cls = screen.getByRole('button', { name: '관심종목 추가' }).getAttribute('class') ?? '';
    expect(cls).toContain('opacity-45');
    expect(cls).toContain('group-hover:opacity-100');
  });
});
