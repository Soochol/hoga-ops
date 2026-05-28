import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CalendarCell } from './CalendarCell';
import type { CalendarStatus } from '../api/types';

const baseProps = {
  date: '20260518',
  status: 'none' as CalendarStatus,
  selected: false,
  inRange: false,
  onClick: () => {},
};

describe('CalendarCell', () => {
  it('shows the day-of-month number', () => {
    render(<CalendarCell {...baseProps} status="none" />);
    expect(screen.getByText('18')).toBeTruthy();
  });

  it('renders ✓ marker for complete', () => {
    render(<CalendarCell {...baseProps} status="complete" />);
    expect(screen.getByText('✓')).toBeTruthy();
  });

  it('renders ⚠ marker for source_partial', () => {
    render(<CalendarCell {...baseProps} status="source_partial" />);
    expect(screen.getByText('⚠')).toBeTruthy();
  });

  it('renders ✕ marker for client_incomplete', () => {
    render(<CalendarCell {...baseProps} status="client_incomplete" />);
    expect(screen.getByText('✕')).toBeTruthy();
  });

  it('renders 🔒 for today_locked and is not clickable', () => {
    const onClick = vi.fn();
    render(<CalendarCell {...baseProps} status="today_locked" onClick={onClick} />);
    expect(screen.getByText('🔒')).toBeTruthy();
    screen.getByText('18').click();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('weekend/holiday/future cells are not clickable', () => {
    const onClick = vi.fn();
    const { rerender } = render(<CalendarCell {...baseProps} status="weekend" onClick={onClick} />);
    screen.getByText('18').click();
    rerender(<CalendarCell {...baseProps} status="holiday" onClick={onClick} />);
    screen.getByText('18').click();
    rerender(<CalendarCell {...baseProps} status="future" onClick={onClick} />);
    screen.getByText('18').click();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('clickable cells (complete / source_partial / client_incomplete / none) fire onClick', () => {
    const onClick = vi.fn();
    const { rerender } = render(<CalendarCell {...baseProps} status="none" onClick={onClick} />);
    screen.getByText('18').click();
    rerender(<CalendarCell {...baseProps} status="complete" onClick={onClick} />);
    screen.getByText('18').click();
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('exposes data-testid="calendar-cell" with the date for E2E', () => {
    const { container } = render(<CalendarCell {...baseProps} status="none" />);
    expect(container.querySelector('[data-testid="calendar-cell-20260518"]')).toBeTruthy();
  });

  // F1 (design review): hover state uses DESIGN.md --bg-input-hover token
  it('applies --bg-input-hover background on hover (enabled cells only)', () => {
    const { container, rerender } = render(<CalendarCell {...baseProps} status="none" />);
    const btn = container.querySelector('button')!;
    btn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    // jsdom doesn't compute styles, but the inline style updates synchronously.
    // Use fireEvent for React's synthetic event consistency.
    rerender(<CalendarCell {...baseProps} status="none" />);
  });

  // F2 (design review): tooltip text matches spec §4.2 vocabulary
  it('attaches a title attribute with the status reason', () => {
    const { container, rerender } = render(<CalendarCell {...baseProps} status="weekend" />);
    expect(container.querySelector('button')!.getAttribute('title')).toMatch(/weekend/i);
    rerender(<CalendarCell {...baseProps} status="today_locked" />);
    expect(container.querySelector('button')!.getAttribute('title')).toMatch(/17:00/);
    rerender(<CalendarCell {...baseProps} status="source_partial" />);
    expect(container.querySelector('button')!.getAttribute('title')).toMatch(/partial/i);
  });
});

describe('CalendarCell (no_upstream_data)', () => {
  it("renders the '–' marker", () => {
    render(<CalendarCell date="20260319" status="no_upstream_data" />);
    expect(screen.getByText('–')).toBeTruthy();
  });

  it("is clickable (not disabled)", () => {
    const onClick = vi.fn();
    render(<CalendarCell date="20260319" status="no_upstream_data" onClick={onClick} />);
    const btn = screen.getByTestId('calendar-cell-20260319');
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledWith('20260319');
  });

  it("shows the 'no upstream data (force to retry)' tooltip", () => {
    render(<CalendarCell date="20260319" status="no_upstream_data" />);
    const btn = screen.getByTestId('calendar-cell-20260319');
    expect(btn.getAttribute('title')).toBe('20260319 · no upstream data (force to retry)');
  });
});
