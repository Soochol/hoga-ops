import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TitleBarSymbolRow } from './TitleBarSymbolRow';
import { useLiveVenueStore } from '../../state/liveVenue';
import { publishWindowWarnings, clearWindowWarnings } from './windowWarningsSource';

// useConnectionLiveness 는 모듈 레벨 WS 상태를 읽어 테스트에선 live=false 이므로,
// 수집 점 케이스가 제어할 수 있게 hoist mock 한다.
const { mockLiveness } = vi.hoisted(() => ({ mockLiveness: vi.fn().mockReturnValue(false) }));
vi.mock('../../api/useConnectionLiveness', () => ({ useConnectionLiveness: () => mockLiveness() }));

function renderRow(
  props: { name?: string | null; code?: string; isIndex?: boolean; windowId?: string },
  opts: {
    watchlistCodes?: string[];
    quote?: { price: number; change_pct: number | null; change_won: number | null };
    liveSet?: string[];
  } = {},
) {
  const { name = '삼성전자', code = '005930', isIndex = false, windowId = 'w1' } = props;
  const { watchlistCodes = [], quote, liveSet = [] } = opts;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['watchlist'], {
    entries: watchlistCodes.map((c) => ({
      code: c, name: c, registered_at_kst_date: '20260101', last_success_date: null,
    })),
    next_run_at_ms: 0,
  });
  if (quote) {
    qc.setQueryData(['live-quotes', code, 'KRX'], { phase: 'open', quotes: [{ code, ...quote }] });
  }
  qc.setQueryData(['live', 'status'], {
    running: true, started_at_ms: 1, last_tick_ms: 1, cycle_lag_ms: 0,
    capture_healthy: true, capture_reason: 'healthy',
    watchlist_count: watchlistCodes.length, kis_calls_today: 0, kis_rate_limit_remaining: null,
    live_set: liveSet,
  });
  return render(
    <QueryClientProvider client={qc}>
      <TitleBarSymbolRow name={name} code={code} isIndex={isIndex} windowId={windowId} />
    </QueryClientProvider>,
  );
}

describe('TitleBarSymbolRow', () => {
  beforeEach(() => {
    cleanup();
    mockLiveness.mockReturnValue(false);
    useLiveVenueStore.setState({ venue: 'KRX' });
    clearWindowWarnings('w1');
  });

  it('renders 종목명(코드)', () => {
    renderRow({ name: '삼성전자', code: '005930' });
    expect(screen.getByTestId('titlebar-symbol-row').textContent).toContain('삼성전자(005930)');
  });

  it('falls back to bare code when name is null', () => {
    renderRow({ name: null, code: '005930' });
    const text = screen.getByTestId('titlebar-symbol-row').textContent ?? '';
    expect(text).toContain('005930');
    expect(text).not.toContain('(005930)');
  });

  it('shows current price from quote.price (candles 폴백 없음)', () => {
    renderRow({ code: '005930' }, { quote: { price: 72000, change_pct: 1.2, change_won: 850 } });
    expect(screen.getByTestId('titlebar-current-price').textContent).toContain('72,000');
  });

  it('omits price when there is no quote', () => {
    renderRow({ code: '005930' });
    expect(screen.queryByTestId('titlebar-current-price')).toBeNull();
  });

  it('shows 등락률(%) only, no 등락액', () => {
    renderRow({ code: '005930' }, { quote: { price: 72000, change_pct: 1.2, change_won: 850 } });
    const change = screen.getByTestId('titlebar-change').textContent ?? '';
    expect(change).toContain('1.20%');
    expect(change).not.toContain('850');
  });

  it('shows the realtime dot when in live_set and WS connected', () => {
    mockLiveness.mockReturnValue(true);
    renderRow({ code: '005930' }, { watchlistCodes: ['005930'], liveSet: ['005930'] });
    expect(screen.getByLabelText('실시간 수집 중')).toBeInTheDocument();
  });

  it('hides price·change·dot for an index window', () => {
    renderRow(
      { name: 'KOSPI', code: 'KOSPI', isIndex: true },
      { quote: { price: 2650, change_pct: 0.5, change_won: 13 } },
    );
    expect(screen.getByTestId('titlebar-symbol-row').textContent).toContain('KOSPI');
    // 지수는 quote 조회 자체를 안 하므로 현재가·등락률 셀이 없다.
    expect(screen.queryByTestId('titlebar-current-price')).toBeNull();
    expect(screen.queryByTestId('titlebar-change')).toBeNull();
  });

  it('shows the 호가 미수집 chip from published windowWarnings', () => {
    renderRow({ code: '005930', windowId: 'w1' });
    act(() => {
      publishWindowWarnings('w1', { hogaGapDates: ['20260520', '20260521'], backfillEarliestDate: null });
    });
    expect(screen.getByTestId('hoga-coverage-gap-chip').textContent).toContain('호가 미수집 2일');
  });

  it('shows the 과거 로딩 중 chip from published backfillEarliestDate', () => {
    renderRow({ code: '005930', windowId: 'w1' });
    act(() => {
      publishWindowWarnings('w1', { hogaGapDates: [], backfillEarliestDate: '20260527' });
    });
    expect(screen.getByTestId('past-backfill-progress-chip').textContent).toContain('5/27까지');
  });
});
