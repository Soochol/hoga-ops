import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import SessionTape from './SessionTape';

// A weekday (Wed 2026-07-08) mid-session vs a Saturday, in KST wall-clock.
// 09:00 KST = 00:00 UTC; mid-session 12:15 KST = 03:15 UTC.
const WED_MID = Date.parse('2026-07-08T03:15:00Z');
const SAT_MID = Date.parse('2026-07-11T03:15:00Z');

describe('SessionTape', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('mid-session weekday: fill ~50% and a playhead', () => {
    vi.setSystemTime(WED_MID); // 3.25h into a 6.5h session
    render(<SessionTape />);
    const fill = screen.getByTestId('session-tape-fill');
    // 3.25/6.5 = 50% (jsdom normalizes 50.000% → 50%)
    expect(fill.style.width).toBe('50%');
    expect(screen.getByTestId('session-tape-head')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '50');
  });

  it('weekend: track only, no playhead, no aria-valuenow', () => {
    vi.setSystemTime(SAT_MID);
    render(<SessionTape />);
    expect(screen.queryByTestId('session-tape-head')).toBeNull();
    expect(screen.getByTestId('session-tape-fill').style.width).toBe('0%');
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
  });

  it('playhead carries the reduced-motion-guarded pulse class', () => {
    vi.setSystemTime(WED_MID);
    render(<SessionTape />);
    expect(screen.getByTestId('session-tape-head').className).toContain('session-head-pulse');
  });
});
