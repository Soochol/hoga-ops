import { act, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProgramTradeTickWindow } from './ProgramTradeTickWindow';
import { useLiveVenueStore } from '../../state/liveVenue';

const mock = vi.hoisted(() => ({
  program: [] as Record<string, unknown>[],
  useLiveSeries: vi.fn(), connected: true,
}));
vi.mock('../../api/liveSeries', () => ({ useLiveSeries: mock.useLiveSeries }));
vi.mock('../useEffectiveVenue', () => ({ useEffectiveVenue: (_code: string, venue: string) => venue }));
vi.mock('../../api/programTradeTicks', () => ({ useProgramTradeHistory: () => ({ data: undefined,
  hasNextPage: false, isFetching: false, isError: false, isFetchNextPageError: false }) }));
vi.mock('../../api/useConnectionLiveness', () => ({ useConnectionLiveness: () => mock.connected }));
vi.mock('../../util/useKstDay', () => ({ useKstDay: () => '20261015' }));
const T = Date.UTC(2026, 9, 15, 5, 52, 52);

beforeEach(() => {
  mock.program = [];
  mock.connected = true;
  mock.useLiveSeries.mockImplementation(() => ({ program: mock.program }));
  useLiveVenueStore.setState({ venue: 'KRX' });
});

describe('ProgramTradeTickWindow', () => {
  it('renders three columns with latest first and signed net-flow colors', () => {
    mock.program = [
      { t_ms: T, price: 125500, event_delta_qty: 1200 },
      { t_ms: T + 1000, price: 125400, event_delta_qty: -300 },
    ];
    render(<ProgramTradeTickWindow code="005930" />);
    const table = screen.getByRole('table', { name: '프로그램 체결 내역' });
    expect(within(table).getAllByRole('columnheader').map(el => el.textContent))
      .toEqual(['수신시각', '현재가(원)', '순매수 증감(주)']);
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('14:52:53125,400−300');
    expect(screen.getByText('+1,200')).toHaveClass('text-price-up');
    expect(screen.getByText('−300')).toHaveClass('text-price-down');
  });
  it('uses each event price and never fills a missing price from another event', () => {
    mock.program = [{ t_ms: T, event_delta_qty: 25 }, { t_ms: T + 1000, price: 100, event_delta_qty: 10 }];
    render(<ProgramTradeTickWindow code="005930" />);
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText('100')).toBeInTheDocument();
  });
  it('shows empty state for old payloads without FID 211, and live updates replace the symbol contents', () => {
    mock.program = [{ t_ms: T, price: 125500, net_qty: 100 }];
    const view = render(<ProgramTradeTickWindow code="005930" />);
    expect(screen.getByText(/새 수신 대기/)).toBeInTheDocument();
    mock.program = [{ t_ms: T, price: 125500, event_delta_qty: 50 }];
    view.rerender(<ProgramTradeTickWindow code="005930" />);
    expect(screen.getByText('+50')).toBeInTheDocument();
    mock.program = [];
    view.rerender(<ProgramTradeTickWindow code="000660" />);
    expect(screen.queryByText('+50')).not.toBeInTheDocument();
    expect(mock.useLiveSeries).toHaveBeenLastCalledWith('000660', 'KRX');
  });
  it('passes the selected venue to the shared feed without a chart link', () => {
    render(<ProgramTradeTickWindow code="005930" />);
    expect(mock.useLiveSeries).toHaveBeenLastCalledWith('005930', 'KRX');
    act(() => useLiveVenueStore.setState({ venue: 'NXT' }));
    expect(mock.useLiveSeries).toHaveBeenLastCalledWith('005930', 'NXT');
  });
  it('shows disconnected waiting state', () => {
    mock.connected = false;
    render(<ProgramTradeTickWindow code="005930" />);
    expect(screen.getByText(/실시간 연결 확인 중/)).toBeInTheDocument();
  });
});
