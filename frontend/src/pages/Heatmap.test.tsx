import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { it, expect, vi, beforeEach } from 'vitest';

// 독립 스토어(ADR-0068): 페이지는 useHeatmap → getHeatmap('/api/heatmap')을 부른다.
vi.mock('../api/heatmap', async (orig) => ({
  ...(await orig<typeof import('../api/heatmap')>()),
  getHeatmap: vi.fn(() => Promise.resolve({
    folders: [{ id: 'f1', name: '반도체', order: 0 }],
    entries: [
      { code: '005930', name: '삼성전자', folder_id: 'f1', order: 0 },
      { code: '000660', name: 'SK하이닉스', folder_id: 'f1', order: 1 },
    ],
  })),
}));

// 005930(order0) -2%, 000660(order1) +5% — manual≠change 라 토글이 관측 가능.
// 005930(order0) -2%, 000660(order1) +5% — manual≠change 라 토글이 관측 가능.
vi.mock('../api/liveQuotes', async (orig) => ({
  ...(await orig<typeof import('../api/liveQuotes')>()),
  useLiveQuoteOverlay: vi.fn(() => ({
    quoteByCode: new Map([
      ['005930', { code: '005930', price: 70000, change_pct: -2, change_won: -1400 }],
      ['000660', { code: '000660', price: 200000, change_pct: 5, change_won: 10000 }],
    ]),
    phase: 'open',
    dataUpdatedAt: 0,
  })),
}));

const { useLiveStatusMock } = vi.hoisted(() => ({ useLiveStatusMock: vi.fn() }));
vi.mock('../api/liveStatus', async (orig) => ({
  ...(await orig<typeof import('../api/liveStatus')>()),
  useLiveStatus: useLiveStatusMock,
}));

// 단일 뷰 모델(ADR-0113): 행 클릭은 useJumpToLive → activateLiveCode(code, label?)로 흐른다.
const { activateLiveCode, openLiveInNewTab } = vi.hoisted(() => ({
  activateLiveCode: vi.fn(),
  openLiveInNewTab: vi.fn(),
}));
vi.mock('../live/liveNavigate', () => ({
  activateLiveCode,
  activateLiveInstrument: vi.fn(),
  openLiveInNewTab,
}));

import { Heatmap } from './Heatmap';
import { useHeatmapPrefsStore } from '../state/heatmapPrefs';
import { useLiveQuoteOverlay } from '../api/liveQuotes';

function renderPage() {
  const qc = new QueryClient();
  return render(<QueryClientProvider client={qc}><MemoryRouter><Heatmap /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  activateLiveCode.mockClear();
  openLiveInNewTab.mockClear();
  useHeatmapPrefsStore.setState({ sortMode: 'manual', groupSort: 'manual' });   // eng-review D2: 기본 manual
  Element.prototype.scrollIntoView = vi.fn();              // jsdom 미구현 — 스트립 점프 대비
  // 매 테스트 open 기본값으로 리셋 — per-test override가 다음 테스트로 누수되지 않게.
  vi.mocked(useLiveQuoteOverlay).mockReturnValue({
    quoteByCode: new Map([
      ['005930', { code: '005930', price: 70000, change_pct: -2, change_won: -1400 }],
      ['000660', { code: '000660', price: 200000, change_pct: 5, change_won: 10000 }],
    ]),
    phase: 'open', dataUpdatedAt: 0,
  } as ReturnType<typeof useLiveQuoteOverlay>);
  useLiveStatusMock.mockClear();
});

it('폴더·종목·phase 배지 렌더 + 색 범례 제거됨(#6)', async () => {
  renderPage();
  const routeShell = await screen.findByTestId('heatmap-page-primary');
  // 페이지 통일(2026-07-23): flat — 안착 그림자·카드 배경 스텝을 제거해 필드(--bg)에
  // 평평하게 얹힌다(/study 통일). PanelCard flat prop. 테두리는 여전히 borderless.
  expect(routeShell).toHaveClass('bg-bg');
  expect(routeShell).not.toHaveClass('bg-bg-card');
  expect(routeShell).not.toHaveClass('border');
  expect(routeShell).not.toHaveClass('shadow-panel');
  expect(await screen.findByTestId('heatmap-board')).toBeInTheDocument();
  expect((await screen.findAllByText('반도체')).length).toBeGreaterThanOrEqual(2);
  expect(screen.getByText('삼성전자')).toBeInTheDocument();
  expect(screen.getByText('● 장중')).toBeInTheDocument();
  expect(screen.queryByLabelText(/색 범례/)).toBeNull();   // #6: 범례 삭제
  // 정렬 = 드로어와 공유하는 아이콘 순환 버튼(role=button, accessible name 보존).
  expect(screen.getByRole('button', { name: '종목 정렬' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '그룹 정렬' })).toBeInTheDocument();
});

it('행 클릭 → 현재 뷰로 종목 열기(jump-to-live)', async () => {
  renderPage();
  fireEvent.click(await screen.findByTestId('heatmap-row-005930'));
  expect(activateLiveCode).toHaveBeenCalledWith('005930', '삼성전자');
});

it('Ctrl/Meta-click 은 새 브라우저 탭으로 열고 현재 뷰는 그대로 둔다', async () => {
  renderPage();
  fireEvent.click(await screen.findByTestId('heatmap-row-005930'), { ctrlKey: true });
  fireEvent.click(await screen.findByTestId('heatmap-row-005930'), { metaKey: true });
  expect(openLiveInNewTab).toHaveBeenCalledTimes(2);
  expect(openLiveInNewTab).toHaveBeenCalledWith({ kind: 'stock', code: '005930', label: '삼성전자' });
  expect(activateLiveCode).not.toHaveBeenCalled();
});

it('기본 manual=order 순, 종목 정렬 1클릭(manual→desc) 시 등락률 내림차순', async () => {
  renderPage();
  await screen.findAllByText('반도체');   // 스트립 칩+헤더로 중복 → All (렌더 대기용)
  const manual = screen.getAllByText(/삼성전자|SK하이닉스/).map((n) => n.textContent);
  expect(manual).toEqual(['삼성전자', 'SK하이닉스']);          // order 0,1
  fireEvent.click(screen.getByRole('button', { name: '종목 정렬' }));   // manual→desc
  const change = screen.getAllByText(/삼성전자|SK하이닉스/).map((n) => n.textContent);
  expect(change).toEqual(['SK하이닉스', '삼성전자']);          // +5% 먼저
});

it('히트맵은 quote-only 표면이라 Live Capture 상태를 조회하지 않는다', async () => {
  renderPage();
  expect(await screen.findByText('삼성전자')).toBeInTheDocument();
  expect(screen.queryByText('KIS 자격증명이 설정되지 않았습니다')).toBeNull();
  expect(useLiveStatusMock).not.toHaveBeenCalled();
});

it('섹터 온도 스트립 칩 렌더(반도체 평균 +1.5%)', async () => {
  renderPage();
  // 005930 -2%, 000660 +5% → 평균 +1.5%
  expect(await screen.findByRole('button', { name: /반도체 평균 \+1\.5% — 카드로 이동/ })).toBeInTheDocument();
});

it('스트립 칩 클릭 → 해당 카드로 scrollIntoView', async () => {
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: /반도체 평균/ }));
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith(
    expect.objectContaining({ behavior: 'smooth' }),
  );
});

it('그룹 정렬 순환 버튼: 클릭마다 store.groupSort 갱신(manual→desc→asc→manual)(#7)', async () => {
  renderPage();
  await screen.findAllByText('반도체');
  expect(useHeatmapPrefsStore.getState().groupSort).toBe('manual');
  const btn = screen.getByRole('button', { name: '그룹 정렬' });
  fireEvent.click(btn);
  expect(useHeatmapPrefsStore.getState().groupSort).toBe('desc');
  fireEvent.click(btn);
  expect(useHeatmapPrefsStore.getState().groupSort).toBe('asc');
  fireEvent.click(btn);
  expect(useHeatmapPrefsStore.getState().groupSort).toBe('manual');
});

it('검색: 종목명 부분일치로 행 필터 + 헤더 카운트 감소', async () => {
  renderPage();
  await screen.findAllByText('반도체');
  expect(screen.getByText(/2종목/)).toBeInTheDocument();
  fireEvent.change(screen.getByTestId('heatmap-search'), { target: { value: '삼성' } });
  expect(screen.getByText('삼성전자')).toBeInTheDocument();
  expect(screen.queryByText('SK하이닉스')).toBeNull();
  expect(screen.getByText(/1종목/)).toBeInTheDocument();
});
