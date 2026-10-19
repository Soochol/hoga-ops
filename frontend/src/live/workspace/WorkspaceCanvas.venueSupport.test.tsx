import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceStore, type GroupSymbol, type WorkspaceWindow } from '../../state/workspace';
import { useLiveVenueStore } from '../../state/liveVenue';
import { seedSymbolMaster, symbolHit } from '../seedSymbolMaster';
import { WorkspaceCanvas } from './WorkspaceCanvas';

vi.mock('./ChartWindow', () => ({ ChartWindow: () => <div>chart</div> }));
vi.mock('./DataWindow', () => ({ DataWindow: () => <div>data</div> }));
vi.mock('./TitleBarSymbolRow', () => ({ TitleBarSymbolRow: () => <div>symbol</div> }));

const samsung: GroupSymbol = { code: '005930', name: '삼성전자' };
const hynix: GroupSymbol = { code: '000660', name: 'SK하이닉스' };

function setup(pinned?: GroupSymbol) {
  const windows: WorkspaceWindow[] = [
    { id: 'book', kind: 'book', group: 1, rect: { x: 0, y: 0, w: .45, h: .8 } },
    { id: 'order', kind: 'order', group: 1, rect: { x: .45, y: 0, w: .55, h: .8 }, pinned },
  ];
  useWorkspaceStore.setState({ windows, zOrder: ['book', 'order'], groupSymbols: { 1: samsung }, maximizedId: null, pendingNormalize: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedSymbolMaster(client);
  const { container } = render(<QueryClientProvider client={client}><WorkspaceCanvas /></QueryClientProvider>);
  const book = within(container.querySelector<HTMLElement>('[data-win="book"]')!);
  const order = within(container.querySelector<HTMLElement>('[data-win="order"]')!);
  return { client, book, order };
}

describe('10호가·호가주문 종목 지원 배지', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
    useLiveVenueStore.setState({ venue: 'KRX' });
  });
  afterEach(() => vi.restoreAllMocks());

  it('미확인 정보를 미지원으로 단정하지 않고 마스터 갱신을 두 창에 반영한다', async () => {
    const { client, book, order } = setup();
    expect(book.getByLabelText('NXT 지원 여부 미확인')).toBeInTheDocument();
    expect(order.getByLabelText('NXT 지원 여부 미확인')).toBeInTheDocument();

    act(() => seedSymbolMaster(client, [symbolHit('005930', null)]));
    expect(screen.queryByLabelText('NXT 거래 미지원')).not.toBeInTheDocument();

    act(() => seedSymbolMaster(client, [symbolHit('005930', true)]));
    await waitFor(() => expect(book.getByLabelText('NXT 거래 지원')).toBeInTheDocument());
    expect(order.getByLabelText('NXT 거래 지원')).toBeInTheDocument();
    expect(book.getByLabelText('KRX 거래 지원')).toHaveTextContent('KRX ✓');
    expect(order.getByLabelText('KRX 거래 지원')).toHaveTextContent('KRX ✓');

    act(() => seedSymbolMaster(client, [symbolHit('005930', false)]));
    await waitFor(() => expect(book.getByLabelText('NXT 거래 미지원')).toBeInTheDocument());
    expect(order.getByLabelText('NXT 거래 미지원')).toHaveTextContent('NXT 미지원');
  });

  it('시세 선택과 독립적으로 각 창의 실제 종목(핀 포함)을 표시한다', async () => {
    const { client, book, order } = setup(hynix);
    act(() => seedSymbolMaster(client, [symbolHit('005930', true), symbolHit('000660', false)]));
    await waitFor(() => expect(book.getByLabelText('NXT 거래 지원')).toBeInTheDocument());
    expect(order.getByLabelText('NXT 거래 미지원')).toBeInTheDocument();

    act(() => useLiveVenueStore.setState({ venue: 'NXT' }));
    expect(book.getByLabelText('NXT 거래 지원')).toHaveTextContent('NXT ✓');
    expect(order.getByLabelText('NXT 거래 미지원')).toHaveTextContent('NXT 미지원');
    expect(book.queryByRole('button', { name: 'NXT' })).not.toBeInTheDocument();
    expect(book.getByLabelText('NXT 거래 지원').tagName).toBe('SPAN');

    act(() => useWorkspaceStore.getState().setGroupSymbol(1, hynix));
    expect(book.getByLabelText('NXT 거래 미지원')).toBeInTheDocument();
    expect(order.getByLabelText('NXT 거래 미지원')).toBeInTheDocument();
  });

  it('종목 없는 창과 지수 창에는 국내 종목 지원 배지를 표시하지 않는다', () => {
    setup();
    act(() => useWorkspaceStore.setState({ groupSymbols: {} }));
    expect(screen.queryByLabelText('종목 지원 거래소')).not.toBeInTheDocument();
    act(() => useWorkspaceStore.getState().setGroupSymbol(1, { kind: 'index', code: 'KOSPI', name: '코스피' }));
    expect(screen.queryByLabelText('종목 지원 거래소')).not.toBeInTheDocument();
  });
});
