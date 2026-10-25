import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TradeWindow } from './TradeWindow';
import { useLiveCursorStore } from '../useLiveCursorStore';
import { LIVE_SETTINGS_KEY } from '../../api/liveSettings';
import type { TradeSpotResponse } from '../../api/tradeSpot';

const mocked = vi.hoisted(() => ({ apiCall: vi.fn() }));
vi.mock('../../api/client', () => ({ apiCall: mocked.apiCall }));
vi.mock('../../api/liveSeries', () => ({ useLiveSeries: () => ({ trade: [] }) }));
vi.mock('../../api/tradeHistory', () => ({ useTradeHistory: () => ({
  data: { pages: [] }, hasNextPage: false, isFetching: false, isError: false, isFetchNextPageError: false,
}) }));
vi.mock('../useEffectiveVenue', () => ({ useEffectiveVenue: () => 'UN' }));
vi.mock('../../api/useConnectionLiveness', () => ({ useConnectionLiveness: () => true }));
vi.mock('../../util/useKstDay', () => ({ useKstDay: () => '20261025' }));

const T = Date.parse('2026-09-29T09:31:20+09:00');
const settings = { schema_version: 1, rest_bypass_enabled: false, screener_depth_autocollect: false, krx_prefer_hogaplay: true };
const response = (start = T, aggregate = false): TradeSpotResponse => ({
  code: '005930', date: '20260929', venue: 'KRX', source_pref: aggregate ? 'kiwoom_live' : 'hogaplay',
  from_ms: start, to_ms: start + 10000, source: aggregate ? 'kiwoom_live' : 'hogaplay',
  representation: aggregate ? 'second_price_aggregate' : 'ticks', status: 'observed', coverage: 'unverified', storage_error: null,
  rows: [{ event_id: String(start), t_ms: start, price: aggregate ? 200 : 100, qty: 10, side: 1, count: aggregate ? 2 : 1 }],
  previous_observed_ms: null, prev_close: 95, revision: 'r1', has_more: false, next_cursor: null,
});
const hover = (start = T, group = 1, code = '005930') => useLiveCursorStore.getState().setSidebarCursor(start,
  { windowId: 'chart', code, group, timeframe: '10s', venue: 'KRX', barStartMs: start });

beforeEach(() => {
  useLiveCursorStore.getState().resetCursor();
  mocked.apiCall.mockReset();
  mocked.apiCall.mockImplementation((url: string) => Promise.resolve(url === '/api/live/settings' ? settings
    : response(Number(new URL(url, 'http://test').searchParams.get('from_ms')), url.includes('source_pref=kiwoom_live'))));
});
afterEach(cleanup);

function mount(withSettings = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (withSettings) client.setQueryData(LIVE_SETTINGS_KEY, settings);
  const rendered = render(<QueryClientProvider client={client}><TradeWindow code="005930" group={1} minAmountManwon={1000} /></QueryClientProvider>);
  return { client, ...rendered };
}

it('loads the cursor date and publishing market, switches source with settings, and restores latest on leave', async () => {
  hover();
  const { client } = mount();
  await screen.findByText('hogaplay · 원본 체결 · 실제 체결가');
  expect(mocked.apiCall.mock.calls.some(([url]) => url.includes('date=20260929&venue=KRX&source_pref=hogaplay'))).toBe(true);
  expect(screen.getByTestId('trade-window')).toHaveAttribute('data-mode', 'spot');
  act(() => { client.setQueryData(LIVE_SETTINGS_KEY, { ...settings, krx_prefer_hogaplay: false }); });
  await screen.findByText('WS · 1초 집계 · 실제 체결가');
  expect(screen.getByRole('columnheader', { name: '합산량(주)' })).toBeInTheDocument();
  expect(screen.getByText('2건')).toBeInTheDocument();
  expect(screen.getByText('개별 체결금액 필터·대량 체결 강조 일시 중지')).toBeInTheDocument();
  expect(screen.queryByTestId('trade-qty-highlighted')).not.toBeInTheDocument();
  act(() => useLiveCursorStore.getState().clearSidebarCursorFrom('chart'));
  expect(screen.getByTestId('trade-window')).toHaveAttribute('data-mode', 'latest');
  client.clear();
});

it('does not query before source settings load and ignores another group or pinned subject', async () => {
  const deferred = new Promise(() => {});
  mocked.apiCall.mockReturnValue(deferred);
  hover();
  const { client } = mount(false);
  await waitFor(() => expect(mocked.apiCall).toHaveBeenCalledTimes(1));
  expect(mocked.apiCall).toHaveBeenCalledWith('/api/live/settings');
  act(() => hover(T, 2));
  expect(screen.getByTestId('trade-window')).toHaveAttribute('data-mode', 'latest');
  act(() => hover(T, 1, '000660'));
  expect(screen.getByTestId('trade-window')).toHaveAttribute('data-mode', 'latest');
  client.clear();
});

it('cancels the old candle request and never displays its late result under the new candle', async () => {
  let finish: ((value: TradeSpotResponse) => void) | undefined;
  let oldSignal: AbortSignal | undefined;
  mocked.apiCall.mockImplementation((url: string, init: RequestInit) => {
    const start = Number(new URL(url, 'http://test').searchParams.get('from_ms'));
    if (start === T) {
      oldSignal = init.signal as AbortSignal;
      return new Promise<TradeSpotResponse>(resolve => { finish = resolve; });
    }
    return Promise.resolve(response(start, true));
  });
  hover();
  const { client } = mount();
  await waitFor(() => expect(finish).toBeDefined());
  act(() => hover(T + 10000));
  await screen.findByText('WS · 1초 집계 · 실제 체결가');
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => { finish!(response(T)); });
  expect(screen.queryByText('hogaplay · 원본 체결 · 실제 체결가')).not.toBeInTheDocument();
  client.clear();
});
