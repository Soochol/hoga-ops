import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChartWindowIdentity } from './ChartWindowIdentity';
import type { RangeBundle } from '../../api/types';
import { useLiveVenueStore, type LiveVenueOption } from '../../state/liveVenue';

// useConnectionLiveness 는 모듈 레벨 WS 상태(_lastHeartbeatMs=0)를 읽어 테스트에선
// live=false 이므로, 수집 점 케이스가 제어할 수 있게 hoist mock 한다(상태바 테스트 이식).
const { mockLiveness } = vi.hoisted(() => ({ mockLiveness: vi.fn().mockReturnValue(false) }));
vi.mock('../../api/useConnectionLiveness', () => ({ useConnectionLiveness: () => mockLiveness() }));

const EMPTY_BUNDLE: RangeBundle = {
  code: '005930',
  from_date: '20260527',
  to_date: '20260527',
  bucket_ms: 60_000,
  segments: [
    { date: '20260527', session_open_ms: 1748275200000, session_close_ms: 1748298600000, source: 'kis_live' },
  ],
  candles: [],
  quote_ratio: { bucket_ms: 60_000, points: [] },
  fill_strength: { bucket_ms: 60_000, points: [] },
  volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
  volume_profile_by_day: [],
  volume_distributions: [],
  investorPoints: [],
  ask_peaks: [],
  broker_late_entries: [],
};

function bundleWithClose(close: number): RangeBundle {
  return {
    ...EMPTY_BUNDLE,
    candles: [{ ts_ms: 1748275260000, open: close, high: close, low: close, close, vol_a: 1, vol_b: 0 }],
  };
}

function renderIdentity(
  props: {
    stockCode: string | null;
    symbolName?: string | null;
    bundle: RangeBundle | null;
    venue?: LiveVenueOption;
    hogaGapDates?: readonly string[];
    liveTradePrice?: number | null;
    isExtending?: boolean;
    historicalFromDate?: string | null;
  },
  watchlistCodes: string[] = [],
  quote?: { price: number; change_pct: number | null; change_won: number | null; stale?: boolean },
  liveSet: string[] = [],
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['watchlist'], {
    entries: watchlistCodes.map((code) => ({
      code, name: code, registered_at_kst_date: '20260101', last_success_date: null,
    })),
    next_run_at_ms: 0,
  });
  if (props.stockCode && quote) {
    qc.setQueryData(['live-quotes', props.stockCode, props.venue ?? 'KRX'], {
      phase: 'open', quotes: [{ code: props.stockCode, ...quote }],
    });
  }
  qc.setQueryData(['live', 'status'], {
    running: true, started_at_ms: 1, last_tick_ms: 1, cycle_lag_ms: 0,
    capture_healthy: true, capture_reason: 'healthy',
    watchlist_count: watchlistCodes.length, kis_calls_today: 0, kis_rate_limit_remaining: null,
    live_set: liveSet,
  });
  return render(
    <QueryClientProvider client={qc}>
      <ChartWindowIdentity
        stockCode={props.stockCode}
        symbolName={props.symbolName ?? null}
        venue={props.venue ?? 'KRX'}
        bundle={props.bundle}
        liveTradePrice={props.liveTradePrice ?? null}
        hogaGapDates={props.hogaGapDates ?? []}
        isExtending={props.isExtending ?? false}
        historicalFromDate={props.historicalFromDate ?? null}
      />
    </QueryClientProvider>,
  );
}

describe('ChartWindowIdentity', () => {
  beforeEach(() => {
    cleanup();
    mockLiveness.mockReturnValue(false);
    useLiveVenueStore.setState({ venue: 'KRX' });
  });

  it('shows em-dash when there is no symbol', () => {
    renderIdentity({ stockCode: null, symbolName: null, bundle: null });
    expect(screen.getByTestId('chart-window-identity').textContent).toContain('—');
  });

  it('renders 종목명(코드) when both are present', () => {
    renderIdentity({ stockCode: '005930', symbolName: '삼성전자', bundle: EMPTY_BUNDLE });
    expect(screen.getByTestId('chart-window-identity').textContent).toContain('삼성전자(005930)');
  });

  it('omits the price when the candle bundle is empty (대기 중)', () => {
    renderIdentity({ stockCode: '005930', symbolName: '삼성전자', bundle: EMPTY_BUNDLE });
    expect(screen.queryByTestId('chart-window-current-price')).toBeNull();
  });

  it('shows the latest candle close when no trade/quote', () => {
    renderIdentity({ stockCode: '005930', symbolName: '삼성전자', bundle: bundleWithClose(71500) });
    expect(screen.getByTestId('chart-window-current-price').textContent).toBe('71,500');
  });

  it('prefers liveTradePrice over candle close', () => {
    renderIdentity({ stockCode: '005930', symbolName: '삼성전자', bundle: bundleWithClose(71500), liveTradePrice: 71800 });
    expect(screen.getByTestId('chart-window-current-price').textContent).toBe('71,800');
  });

  it('falls back to quote.price when no liveTradePrice', () => {
    renderIdentity(
      { stockCode: '005930', symbolName: '삼성전자', bundle: bundleWithClose(71500) },
      [], { price: 72000, change_pct: 1.2, change_won: 850 },
    );
    expect(screen.getByTestId('chart-window-current-price').textContent).toBe('72,000');
  });

  it('shows 등락률(%) from the live quote (등락액은 헤더에서 생략)', () => {
    renderIdentity(
      { stockCode: '005930', symbolName: '삼성전자', bundle: EMPTY_BUNDLE },
      [], { price: 72000, change_pct: 1.2, change_won: 850 },
    );
    const change = screen.getByTestId('chart-window-change').textContent ?? '';
    expect(change).toContain('1.20%');
    expect(change).not.toContain('850');
  });

  it('omits the change cell when no live quote is available', () => {
    renderIdentity({ stockCode: '005930', symbolName: '삼성전자', bundle: EMPTY_BUNDLE });
    expect(screen.queryByTestId('chart-window-change')).toBeNull();
  });

  it('shows the realtime dot when the code is in live_set and WS is connected', () => {
    mockLiveness.mockReturnValue(true);
    renderIdentity(
      { stockCode: '005930', symbolName: '삼성전자', bundle: EMPTY_BUNDLE }, ['005930'], undefined, ['005930'],
    );
    expect(screen.getByLabelText('실시간 수집 중')).toBeInTheDocument();
  });

  it('shows the disconnected dot when in live_set but WS is not connected', () => {
    mockLiveness.mockReturnValue(false);
    renderIdentity(
      { stockCode: '005930', symbolName: '삼성전자', bundle: EMPTY_BUNDLE }, ['005930'], undefined, ['005930'],
    );
    expect(screen.getByLabelText('연결 재시도 중')).toBeInTheDocument();
  });

  it('omits the collection dot for an index window (stockCode null)', () => {
    renderIdentity({ stockCode: null, symbolName: 'KOSPI', bundle: bundleWithClose(2650) });
    // 지수는 종목명·현재가는 있으나 수집 점·하트·등락률·히트맵은 없다.
    expect(screen.getByTestId('chart-window-identity').textContent).toContain('KOSPI');
    expect(screen.queryByTestId('chart-window-change')).toBeNull();
    expect(screen.queryByRole('button', { name: /관심/ })).toBeNull();
  });

  it('shows the 호가 미수집 chip with day count when past hoga coverage has gaps', () => {
    renderIdentity({
      stockCode: '005930', symbolName: '삼성전자', bundle: EMPTY_BUNDLE,
      hogaGapDates: ['20260520', '20260521'],
    });
    expect(screen.getByTestId('hoga-coverage-gap-chip').textContent).toContain('호가 미수집 2일');
  });

  it('shows the 과거 로딩 중 progress chip while extending', () => {
    renderIdentity({
      stockCode: '005930', symbolName: '삼성전자', bundle: EMPTY_BUNDLE,
      isExtending: true, historicalFromDate: '20260501',
    });
    expect(screen.getByTestId('past-backfill-progress-chip').textContent).toContain('5/27까지');
  });

  it('shows a filled heart (aria-pressed) for a watchlist member', () => {
    renderIdentity({ stockCode: '005930', symbolName: '삼성전자', bundle: EMPTY_BUNDLE }, ['005930']);
    const heart = screen.getByRole('button', { name: /관심/ });
    expect(heart).toHaveAttribute('aria-pressed', 'true');
  });
});
