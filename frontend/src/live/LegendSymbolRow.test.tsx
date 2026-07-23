import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LegendSymbolRow, type SymbolLegendInput } from './LegendSymbolRow';
import type { Candle } from '../api/types';
import { useLiveVenueStore } from '../state/liveVenue';

// useConnectionLiveness 는 모듈 레벨 WS 상태를 읽어 테스트에선 live=false 이므로,
// 수집 점 케이스가 제어할 수 있게 hoist mock 한다(상태바 테스트에서 이식).
const { mockLiveness } = vi.hoisted(() => ({ mockLiveness: vi.fn().mockReturnValue(false) }));
vi.mock('../api/useConnectionLiveness', () => ({ useConnectionLiveness: () => mockLiveness() }));

function candle(close: number): Candle {
  return { ts_ms: 1748275260000, open: close, high: close, low: close, close, vol_a: 1, vol_b: 0 };
}

function renderRow(
  props: Partial<SymbolLegendInput> & { code: string; candles?: readonly Candle[] },
  opts: {
    symbolName?: string;
    watchlistCodes?: string[];
    quote?: { price: number; change_pct: number | null; change_won: number | null };
    liveSet?: string[];
  } = {},
) {
  const { symbolName, watchlistCodes = [], quote, liveSet = [] } = opts;
  const venue = props.venue ?? 'KRX';
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (symbolName) {
    qc.setQueryData(['symbols', 'all'], {
      symbols: [{ code: props.code, name: symbolName, market: 'KOSPI', kind: 'stock' }],
    });
  }
  qc.setQueryData(['watchlist'], {
    entries: watchlistCodes.map((code) => ({
      code, name: code, registered_at_kst_date: '20260101', last_success_date: null,
    })),
    next_run_at_ms: 0,
  });
  if (quote) {
    qc.setQueryData(['live-quotes', props.code, venue], {
      phase: 'open', quotes: [{ code: props.code, ...quote }],
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
      <LegendSymbolRow
        code={props.code}
        venue={venue}
        candles={props.candles}
        hogaGapDates={props.hogaGapDates ?? []}
        backfillEarliestDate={props.backfillEarliestDate ?? null}
      />
    </QueryClientProvider>,
  );
}

describe('LegendSymbolRow', () => {
  beforeEach(() => {
    cleanup();
    mockLiveness.mockReturnValue(false);
    useLiveVenueStore.setState({ venue: 'KRX' });
  });

  it('renders 종목명(코드) when the symbol master has the name', () => {
    renderRow({ code: '005930', candles: [candle(71500)] }, { symbolName: '삼성전자' });
    expect(screen.getByTestId('legend-symbol-row').textContent).toContain('삼성전자(005930)');
  });

  it('falls back to bare code when the name is not loaded', () => {
    renderRow({ code: '005930', candles: [candle(71500)] });
    const text = screen.getByTestId('legend-symbol-row').textContent ?? '';
    expect(text).toContain('005930');
    expect(text).not.toContain('(005930)');
  });

  it('omits the price when there are no candles', () => {
    renderRow({ code: '005930' }, { symbolName: '삼성전자' });
    expect(screen.queryByTestId('legend-current-price')).toBeNull();
  });

  it('shows the latest candle close when no quote', () => {
    renderRow({ code: '005930', candles: [candle(70500), candle(71200)] }, { symbolName: '삼성전자' });
    expect(screen.getByTestId('legend-current-price').textContent).toContain('71,200');
  });

  it('prefers quote.price over candle close', () => {
    renderRow(
      { code: '005930', candles: [candle(71500)] },
      { symbolName: '삼성전자', quote: { price: 72000, change_pct: 1.2, change_won: 850 } },
    );
    expect(screen.getByTestId('legend-current-price').textContent).toContain('72,000');
  });

  it('shows 등락률(%) only (등락액 생략)', () => {
    renderRow(
      { code: '005930', candles: [candle(71500)] },
      { symbolName: '삼성전자', quote: { price: 72000, change_pct: 1.2, change_won: 850 } },
    );
    const change = screen.getByTestId('legend-change').textContent ?? '';
    expect(change).toContain('1.20%');
    expect(change).not.toContain('850');
  });

  it('omits the change cell when no quote is available', () => {
    renderRow({ code: '005930', candles: [candle(71500)] }, { symbolName: '삼성전자' });
    expect(screen.queryByTestId('legend-change')).toBeNull();
  });

  it('shows the realtime dot when in live_set and WS connected', () => {
    mockLiveness.mockReturnValue(true);
    renderRow(
      { code: '005930', candles: [candle(71500)] },
      { symbolName: '삼성전자', watchlistCodes: ['005930'], liveSet: ['005930'] },
    );
    expect(screen.getByLabelText('실시간 수집 중')).toBeInTheDocument();
  });

  it('shows the disconnected dot when in live_set but WS not connected', () => {
    mockLiveness.mockReturnValue(false);
    renderRow(
      { code: '005930', candles: [candle(71500)] },
      { symbolName: '삼성전자', watchlistCodes: ['005930'], liveSet: ['005930'] },
    );
    expect(screen.getByLabelText('연결 재시도 중')).toBeInTheDocument();
  });

  it('shows the 호가 미수집 chip with day count', () => {
    renderRow(
      { code: '005930', candles: [candle(71500)], hogaGapDates: ['20260520', '20260521'] },
      { symbolName: '삼성전자' },
    );
    expect(screen.getByTestId('hoga-coverage-gap-chip').textContent).toContain('호가 미수집 2일');
  });

  it('shows the 과거 로딩 중 chip from backfillEarliestDate', () => {
    renderRow(
      { code: '005930', candles: [candle(71500)], backfillEarliestDate: '20260527' },
      { symbolName: '삼성전자' },
    );
    expect(screen.getByTestId('past-backfill-progress-chip').textContent).toContain('5/27까지');
  });

  it('omits both warning chips when clean', () => {
    renderRow({ code: '005930', candles: [candle(71500)] }, { symbolName: '삼성전자' });
    expect(screen.queryByTestId('hoga-coverage-gap-chip')).toBeNull();
    expect(screen.queryByTestId('past-backfill-progress-chip')).toBeNull();
  });
});
