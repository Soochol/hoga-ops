import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { Countdown } from './Countdown';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('Countdown', () => {
  it('shows hours/minutes/seconds until target', () => {
    const now = Date.UTC(2026, 4, 26, 9, 0, 0);  // 2026-05-26T09:00Z = 18:00 KST
    vi.setSystemTime(now);
    // Target = now + 1h 2m 3s
    const target = now + (1 * 3600 + 2 * 60 + 3) * 1000;
    render(<Countdown targetMs={target} />);
    expect(screen.getByText(/01:02:03/)).toBeInTheDocument();
  });

  it('ticks down every second', () => {
    const now = Date.UTC(2026, 4, 26, 9, 0, 0);
    vi.setSystemTime(now);
    const target = now + 5_000;
    render(<Countdown targetMs={target} />);
    expect(screen.getByText(/00:00:05/)).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(screen.getByText(/00:00:04/)).toBeInTheDocument();
  });

  it('shows 00:00:00 when past target', () => {
    const now = Date.UTC(2026, 4, 26, 9, 0, 0);
    vi.setSystemTime(now);
    render(<Countdown targetMs={now - 1000} />);
    expect(screen.getByText(/00:00:00/)).toBeInTheDocument();
  });
});
