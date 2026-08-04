import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DateRangePicker } from './DateRangePicker';
import type { ReactNode } from 'react';

function W(qc: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

const HISTORY_RESPONSE = {
  cells: [
    { date: '20260518', status: 'complete', captured_at_ms: 1 },
    { date: '20260519', status: 'none', captured_at_ms: null },
    { date: '20260520', status: 'none', captured_at_ms: null },
  ],
  as_of_ms: 1,
};

function setupCalendar() {
  vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue({
    ok: true, status: 200, json: async () => HISTORY_RESPONSE,
  } as Response);
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

beforeEach(() => { vi.restoreAllMocks(); });

describe('DateRangePicker', () => {
  it('renders two months side by side (current + next)', async () => {
    const qc = setupCalendar();
    render(<DateRangePicker code="005930" referenceYear={2026} referenceMonth={5} value={null} onChange={() => {}} />, {
      wrapper: W(qc),
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText('2026.05')).toBeTruthy();
    expect(screen.getByText('2026.06')).toBeTruthy();
  });

  it('first click sets anchor; second click sets end (no swap when ordered)', async () => {
    const qc = setupCalendar();
    const onChange = vi.fn();
    render(<DateRangePicker code="005930" referenceYear={2026} referenceMonth={5} value={null} onChange={onChange} />, {
      wrapper: W(qc),
    });
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.click(screen.getByTestId('calendar-cell-20260519'));
    fireEvent.click(screen.getByTestId('calendar-cell-20260520'));
    expect(onChange).toHaveBeenLastCalledWith({ start: '20260519', end: '20260520' });
  });

  it('second click before anchor swaps start/end', async () => {
    const qc = setupCalendar();
    const onChange = vi.fn();
    render(<DateRangePicker code="005930" referenceYear={2026} referenceMonth={5} value={null} onChange={onChange} />, {
      wrapper: W(qc),
    });
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.click(screen.getByTestId('calendar-cell-20260520'));
    fireEvent.click(screen.getByTestId('calendar-cell-20260519'));
    expect(onChange).toHaveBeenLastCalledWith({ start: '20260519', end: '20260520' });
  });

  it('third click resets to a new start anchor', async () => {
    const qc = setupCalendar();
    const onChange = vi.fn();
    render(<DateRangePicker code="005930" referenceYear={2026} referenceMonth={5} value={null} onChange={onChange} />, {
      wrapper: W(qc),
    });
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.click(screen.getByTestId('calendar-cell-20260518'));
    fireEvent.click(screen.getByTestId('calendar-cell-20260520'));
    fireEvent.click(screen.getByTestId('calendar-cell-20260519'));
    // Third click is a new anchor (range incomplete) — onChange is called with null end.
    expect(onChange).toHaveBeenLastCalledWith({ start: '20260519', end: null });
  });

  it('Q14 re-eval ticks every 60s (interval registered)', async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const qc = setupCalendar();
    render(<DateRangePicker code="005930" referenceYear={2026} referenceMonth={5} value={null} onChange={() => {}} />, {
      wrapper: W(qc),
    });
    await act(async () => { vi.advanceTimersByTime(0); });
    // Verify a 60s interval was scheduled.
    const intervals = setIntervalSpy.mock.calls.map((c) => c[1]);
    expect(intervals).toContain(60_000);
    vi.useRealTimers();
  });

  // Navigation: prev / next / select / Today
  it('Next button advances the visible months by one', async () => {
    const qc = setupCalendar();
    render(<DateRangePicker code="005930" referenceYear={2026} referenceMonth={5} value={null} onChange={() => {}} />, {
      wrapper: W(qc),
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByText('2026.05')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('다음 달'));
    expect(screen.getByText('2026.06')).toBeTruthy();
    expect(screen.getByText('2026.07')).toBeTruthy();
  });

  it('Previous button steps back one month, crossing year boundary', async () => {
    const qc = setupCalendar();
    render(<DateRangePicker code="005930" referenceYear={2026} referenceMonth={1} value={null} onChange={() => {}} />, {
      wrapper: W(qc),
    });
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.click(screen.getByLabelText('이전 달'));
    expect(screen.getByText('2025.12')).toBeTruthy();
    expect(screen.getByText('2026.01')).toBeTruthy();
  });

  it('Year/Month selects jump directly to the chosen month', async () => {
    const qc = setupCalendar();
    render(<DateRangePicker code="005930" referenceYear={2026} referenceMonth={5} value={null} onChange={() => {}} />, {
      wrapper: W(qc),
    });
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.change(screen.getByLabelText('연도'), { target: { value: '2024' } });
    fireEvent.change(screen.getByLabelText('월'), { target: { value: '11' } });
    expect(screen.getByText('2024.11')).toBeTruthy();
    expect(screen.getByText('2024.12')).toBeTruthy();
  });

  it('Today button returns to the reference month and is disabled when already there', async () => {
    const qc = setupCalendar();
    render(<DateRangePicker code="005930" referenceYear={2026} referenceMonth={5} value={null} onChange={() => {}} />, {
      wrapper: W(qc),
    });
    await new Promise((r) => setTimeout(r, 30));
    const today = screen.getByRole('button', { name: '오늘' }) as HTMLButtonElement;
    expect(today.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('다음 달'));
    fireEvent.click(screen.getByLabelText('다음 달'));
    expect(screen.getByText('2026.07')).toBeTruthy();
    expect(today.disabled).toBe(false);
    fireEvent.click(today);
    expect(screen.getByText('2026.05')).toBeTruthy();
  });
});

describe('DateRangePicker reason banner', () => {
  // Helper: mock fetch returning a CalendarResponse with an optional reason.
  // Both useCalendar calls (left + right month) hit the same fetch mock, so
  // the same reason is returned for both months.
  function setupCalendarWithReason(reason: string | null) {
    const response = { ...HISTORY_RESPONSE, reason };
    vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue({
      ok: true, status: 200, json: async () => response,
    } as Response);
    return new QueryClient({ defaultOptions: { queries: { retry: false } } });
  }

  it('shows banner when left month has trading_days_unavailable reason', async () => {
    const qc = setupCalendarWithReason('trading_days_unavailable');
    render(<DateRangePicker code="005930" referenceYear={2026} referenceMonth={5} value={null} onChange={() => {}} />, {
      wrapper: W(qc),
    });
    await new Promise((r) => setTimeout(r, 50));
    // calendarHints.trading_days_unavailable = 소스를 못 읽었다(배포 사고).
    // 재시도 안내를 하지 않는 것이 이 카피의 요점이다.
    expect(screen.getByText(/거래일 달력을 읽지 못해/)).toBeTruthy();
  });

  it('shows the stale-calendar banner distinctly from the unreadable-source one', async () => {
    const qc = setupCalendarWithReason('trading_days_stale');
    render(<DateRangePicker code="005930" referenceYear={2026} referenceMonth={5} value={null} onChange={() => {}} />, {
      wrapper: W(qc),
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText(/거래일 달력이 최신이 아니라/)).toBeTruthy();
  });

  it('hides banner when both months have null reason', async () => {
    const qc = setupCalendarWithReason(null);
    render(<DateRangePicker code="005930" referenceYear={2026} referenceMonth={5} value={null} onChange={() => {}} />, {
      wrapper: W(qc),
    });
    await new Promise((r) => setTimeout(r, 50));
    // 두 사유 카피가 **공통으로** 담는 문구로 확인한다. 예전에는 "휴일 표시가" 로
    // 봤는데, 카피가 바뀌면 그 문자열은 어디에도 없어 **관측 실패가 통과로 읽힌다**.
    expect(screen.queryByText(/근사했습니다/)).toBeNull();
  });
});
