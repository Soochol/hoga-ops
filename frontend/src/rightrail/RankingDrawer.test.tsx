import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import * as client from '../api/client';
import * as liveNavigate from '../live/liveNavigate';
import { RankingDrawer } from './RankingDrawer';

// DnD 는 렌더 골격만 필요 — 실제 센서/포인터는 이 테스트 범위 밖.
vi.mock('@dnd-kit/core', async (orig) => {
  const actual = await orig<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useDraggable: () => ({ setNodeRef: () => {}, listeners: {}, attributes: {}, transform: null, isDragging: false }),
    useSensor: () => ({}),
    useSensors: () => [],
  };
});

const OPEN_RESPONSE = {
  kind: 'change',
  market: 'all',
  direction: 'up',
  rows: [
    { rank: 1, code: '294870', name: 'HDC현대산업개발', price: 24350, change_pct: 29.97 },
    { rank: 2, code: '005930', name: '삼성전자', price: 71200, change_pct: 5.79 },
  ],
  market_open: true,
  fetched_at_ms: 1_700_000_000_000,
};

function renderDrawer() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/live']}>
        <RankingDrawer />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.spyOn(liveNavigate, 'activateLiveCode').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('RankingDrawer', () => {
  it('renders ranked rows and requests /api/live/rankings with default params', async () => {
    const apiCall = vi.spyOn(client, 'apiCall').mockResolvedValue(OPEN_RESPONSE as never);
    renderDrawer();

    expect(await screen.findByText('HDC현대산업개발')).toBeInTheDocument();
    expect(screen.getByText('삼성전자')).toBeInTheDocument();
    // 순위번호가 선행 슬롯에 렌더된다.
    expect(screen.getByText('1')).toBeInTheDocument();
    // 첫 요청 = change/all/up.
    const url = apiCall.mock.calls[0][0] as string;
    expect(url).toContain('kind=change');
    expect(url).toContain('market=all');
    expect(url).toContain('direction=up');
  });

  it('switching kind re-queries with the new kind', async () => {
    const apiCall = vi.spyOn(client, 'apiCall').mockResolvedValue(OPEN_RESPONSE as never);
    renderDrawer();
    await screen.findByText('삼성전자');

    fireEvent.click(screen.getByRole('button', { name: '대금' }));

    await waitFor(() => {
      expect(apiCall.mock.calls.some((c) => (c[0] as string).includes('kind=value'))).toBe(true);
    });
  });

  it('ETF 제외 토글이 exclude_etf=true 로 재조회한다', async () => {
    const apiCall = vi.spyOn(client, 'apiCall').mockResolvedValue(OPEN_RESPONSE as never);
    renderDrawer();
    await screen.findByText('삼성전자');

    // 기본 요청엔 exclude_etf 가 없다.
    expect((apiCall.mock.calls[0][0] as string)).not.toContain('exclude_etf');

    fireEvent.click(screen.getByRole('button', { name: 'ETF 제외' }));

    await waitFor(() => {
      expect(apiCall.mock.calls.some((c) => (c[0] as string).includes('exclude_etf=true'))).toBe(true);
    });
  });

  it('direction toggle shows only on the change kind', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue(OPEN_RESPONSE as never);
    renderDrawer();
    await screen.findByText('삼성전자');

    expect(screen.getByRole('button', { name: '↓하락' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '거래량' }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '↓하락' })).not.toBeInTheDocument();
    });
  });

  it('clicking a row activates that code (jump-to-chart)', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue(OPEN_RESPONSE as never);
    renderDrawer();
    fireEvent.click(await screen.findByText('삼성전자'));
    expect(liveNavigate.activateLiveCode).toHaveBeenCalledWith('005930', '삼성전자');
  });

  it('shows 장 외 when market is closed', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue({ ...OPEN_RESPONSE, market_open: false } as never);
    renderDrawer();
    expect(await screen.findByText('장 외')).toBeInTheDocument();
  });

  it('renders an error state when the request fails', async () => {
    vi.spyOn(client, 'apiCall').mockRejectedValue(new Error('boom'));
    renderDrawer();
    expect(await screen.findByText('조회 실패')).toBeInTheDocument();
  });

  it('sort button re-orders the visible list by 등락률 (client-side)', async () => {
    // 서버 순서: HDC(29.97) → 삼성(5.79). 등락률 desc 는 이미 동순이라, asc 로
    // 두 번 눌러 삼성이 위로 오는지로 재정렬을 확인한다.
    vi.spyOn(client, 'apiCall').mockResolvedValue(OPEN_RESPONSE as never);
    renderDrawer();
    await screen.findByText('삼성전자');

    const rowNames = () =>
      screen.getAllByRole('button', { name: /차트 열기/ }).map((li) => li.getAttribute('aria-label'));
    expect(rowNames()[0]).toContain('HDC현대산업개발'); // 기본 = 서버 순서

    const sortBtn = screen.getByRole('button', { name: '등락률 정렬' });
    fireEvent.click(sortBtn); // → desc
    fireEvent.click(sortBtn); // → asc: 낮은 등락률(삼성 5.79)이 위로
    expect(rowNames()[0]).toContain('삼성전자');
  });
});
