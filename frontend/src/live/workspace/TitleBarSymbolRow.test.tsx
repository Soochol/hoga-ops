import { liveQuotesQueryKey } from '../../api/liveQuotes';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { WatchlistResponse } from '../../api/watchlist';
import { StockDescriptionTooltipProvider } from '../../heatmap/StockDescriptionTooltip';
import { getStockDescription } from '../../heatmap/stockDescriptions';
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
    watchlist?: WatchlistResponse;
    quote?: { price: number; change_pct: number | null; change_won: number | null };
    liveSet?: string[];
  } = {},
) {
  const { name = '삼성전자', code = '005930', isIndex = false, windowId = 'w1' } = props;
  const { watchlistCodes = [], quote, liveSet = [] } = opts;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(['watchlist'], opts.watchlist ?? {
    entries: watchlistCodes.map((c) => ({
      code: c, name: c, registered_at_kst_date: '20260101', last_success_date: null,
    })),
    next_run_at_ms: 0,
  });
  if (quote) {
    qc.setQueryData(liveQuotesQueryKey([code], 'KRX'), { phase: 'open', quotes: [{ code, ...quote }] });
  }
  qc.setQueryData(['live', 'status'], {
    running: true, started_at_ms: 1, last_tick_ms: 1, cycle_lag_ms: 0,
    capture_healthy: true, capture_reason: 'healthy',
    watchlist_count: watchlistCodes.length,
    live_set: liveSet,
  });
  const rendered = render(
    <QueryClientProvider client={qc}>
      <StockDescriptionTooltipProvider>
        <TitleBarSymbolRow name={name} code={code} isIndex={isIndex} windowId={windowId} />
      </StockDescriptionTooltipProvider>
    </QueryClientProvider>,
  );
  return { ...rendered, qc };
}

describe('TitleBarSymbolRow', () => {
  beforeEach(() => {
    cleanup();
    mockLiveness.mockReturnValue(false);
    useLiveVenueStore.setState({ venue: 'KRX' });
    clearWindowWarnings('w1');
  });

  it('종목명과 코드를 표시하고 네이티브 헤더 툴팁을 제거한다', () => {
    renderRow({ name: '삼성전자', code: '005930' });
    expect(screen.getByText('삼성전자')).not.toHaveAttribute('title');
    expect(screen.getByText('005930')).toBeInTheDocument();
  });

  it('shows the US ticker and exchange while keeping its internal identity out of the title', () => {
    renderRow({ name: '버크셔', code: 'us-stock:NYSE:BRKb', isIndex: true });
    expect(screen.getByText('BRKb · NYSE')).toBeInTheDocument();
    expect(screen.getByText('버크셔')).not.toHaveAttribute('title');
    expect(screen.getByTestId('titlebar-symbol-row')).not.toHaveTextContent('us-stock:');
  });

  it('falls back to bare code when name is null', () => {
    renderRow({ name: null, code: '005930' });
    const text = screen.getByTestId('titlebar-symbol-row').textContent ?? '';
    expect(text).toContain('005930');
    expect(text).not.toContain('(005930)');
  });

  it('종목명에만 0.5초 뒤 공통 설명을 열고 다른 헤더 영역·누르기에서는 닫는다', () => {
    vi.useFakeTimers();
    try {
      const { container } = renderRow({}, { quote: { price: 72000, change_pct: 1.2, change_won: 850 },
        liveSet: ['005930'], watchlistCodes: ['005930'] });
      const name = screen.getByText('삼성전자');
      expect(container.querySelectorAll('[title]')).toHaveLength(0);
      fireEvent.mouseEnter(name);
      act(() => vi.advanceTimersByTime(499));
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.getByTestId('stock-description-lines').textContent).toBe(getStockDescription('005930')!.lines.join(''));
      expect(name).toHaveAttribute('aria-describedby', screen.getByRole('tooltip').id);
      fireEvent.mouseLeave(name);
      fireEvent.mouseEnter(screen.getByTestId('titlebar-current-price'));
      act(() => vi.advanceTimersByTime(500));
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
      fireEvent.mouseEnter(name);
      act(() => vi.advanceTimersByTime(250));
      fireEvent.pointerDown(name);
      act(() => vi.advanceTimersByTime(500));
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
      fireEvent.mouseLeave(name);
      fireEvent.mouseEnter(name);
      act(() => vi.advanceTimersByTime(500));
      expect(screen.getByRole('tooltip')).toBeInTheDocument();
      fireEvent.pointerDown(name);
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    } finally { cleanup(); vi.useRealTimers(); }
  });

  it('shows current price from quote.price (candles 폴백 없음)', () => {
    renderRow({ code: '005930' }, { quote: { price: 72000, change_pct: 1.2, change_won: 850 } });
    expect(screen.getByTestId('titlebar-current-price').textContent).toContain('72,000');
  });

  it('reserves price and change slots when there is no quote', () => {
    renderRow({ code: '005930' });
    expect(screen.getByTestId('titlebar-current-price')).toHaveTextContent('—');
    expect(screen.getByTestId('titlebar-change')).toHaveTextContent('—');
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

  it('reserves index quote slots without using a domestic stock quote', () => {
    renderRow(
      { name: 'KOSPI', code: 'KOSPI', isIndex: true },
      { quote: { price: 2650, change_pct: 0.5, change_won: 13 } },
    );
    expect(screen.getByTestId('titlebar-symbol-row').textContent).toContain('KOSPI');
    expect(screen.getByTestId('titlebar-current-price')).toHaveTextContent('—');
    expect(screen.getByTestId('titlebar-change')).toHaveTextContent('—');
    expect(screen.queryByLabelText('실시간 수집 중')).toBeNull();
  });

  it('관심 등록 종목이어도 헤더의 중복 관심 버튼을 표시하지 않는다', () => {
    const folders = [{ id: 'f_a', name: '반도체', order: 0 }, { id: 'f_b', name: '장기', order: 1 }];
    renderRow({ code: '005930' }, { watchlist: { folders, memos: [], next_run_at_ms: 0,
      entries: folders.map(f => ({ code: '005930', name: '삼성전자', folder_id: f.id, order: 0,
        registered_at_kst_date: '20260101', last_success_date: null })),
    } });
    expect(screen.queryByTestId('titlebar-watchlist-button')).toBeNull();
    expect(screen.queryByTestId('watchlist-group-picker')).toBeNull();
  });

  it('keeps the title-bar heart out of index windows', () => {
    renderRow({ name: 'KOSPI', code: 'KOSPI', isIndex: true });
    expect(screen.queryByTestId('titlebar-watchlist-button')).toBeNull();
  });

  it('shows the 과거 불러오는 중 chip from published backfillEarliestDate', () => {
    renderRow({ code: '005930', windowId: 'w1' });
    act(() => {
      publishWindowWarnings('w1', { backfillEarliestDate: '20260527' });
    });
    const progress = screen.getByTestId('past-backfill-progress-chip');
    expect(progress).toHaveTextContent('05/27');
    expect(progress.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(progress).not.toHaveAttribute('title');
    act(() => clearWindowWarnings('w1'));
    expect(screen.getByTestId('past-backfill-progress-chip')).toBe(progress);
    expect(progress).not.toBeVisible();
  });
});
