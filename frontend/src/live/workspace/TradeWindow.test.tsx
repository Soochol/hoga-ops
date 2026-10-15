import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { TradeWindow } from './TradeWindow';
import type { TradeHistoryRow } from '../../api/tradeHistory';
import type { TradeSnapshot } from '../bucketHogaSeries';
import { useChartPrefsStore, DEFAULT_PREFS } from '../../state/chartPrefs';

const mock = vi.hoisted(() => ({ live: [] as TradeSnapshot[], rows: [] as TradeHistoryRow[] }));
vi.mock('../../api/liveSeries', () => ({ useLiveSeries: () => ({ trade: mock.live }) }));
vi.mock('../../api/tradeHistory', () => ({ useTradeHistory: () => ({
  data: { pages: [{ rows: mock.rows, latest_at_ms: null, latest_volume: null, prev_close: 79000 }] },
  hasNextPage: false, isFetching: false, isError: false, isFetchNextPageError: false,
}) }));
vi.mock('../useEffectiveVenue', () => ({ useEffectiveVenue: () => 'KRX' }));
vi.mock('../../api/useConnectionLiveness', () => ({ useConnectionLiveness: () => true }));
vi.mock('../../util/useKstDay', () => ({ useKstDay: () => '20261015' }));
const T = Date.UTC(2026, 9, 15, 5, 32);

beforeEach(() => {
  mock.live = [];
  mock.rows = [];
  useChartPrefsStore.setState(DEFAULT_PREFS);
});

it('filters before the 200-row cap, retains hidden live trades, and resets the reading position when the amount changes', () => {
  mock.rows = Array.from({ length: 205 }, (_, i) => ({ event_id: `history-${i}`, t_ms: T - i * 1000,
    price: 80000, qty: i === 204 ? 125 : 1, side: 1, cum_volume: 1000 - i }));
  const view = render(<TradeWindow code="005930" />);
  expect(screen.getAllByRole('row')).toHaveLength(201);
  expect(screen.queryByRole('cell', { name: '125' })).not.toBeInTheDocument();
  const scroller = screen.getByLabelText('체결 목록');
  scroller.scrollTop = 300;
  fireEvent.scroll(scroller);
  view.rerender(<TradeWindow code="005930" minAmountManwon={1000} />);
  expect(scroller.scrollTop).toBe(0);
  expect(screen.getAllByRole('row')).toHaveLength(2);
  expect(screen.getByRole('cell', { name: '125' })).toBeInTheDocument();
  mock.live = [{ t_ms: T + 1000, prev_close: 79000,
    trades: [{ t_ms: T + 1000, price: 80000, qty: 3, side: -1 }] }];
  view.rerender(<TradeWindow code="005930" minAmountManwon={1000} />);
  expect(screen.queryByRole('cell', { name: '3' })).not.toBeInTheDocument();
  mock.live = [];
  view.rerender(<TradeWindow code="005930" minAmountManwon={0} />);
  expect(screen.getByRole('cell', { name: '3' })).toBeInTheDocument();
  expect(screen.getAllByRole('row')).toHaveLength(201);
});
