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

const { setActiveCode } = vi.hoisted(() => ({ setActiveCode: vi.fn() }));
vi.mock('../state/livePage', () => ({
  useLivePageStore: (sel: (s: { setActiveCode: typeof setActiveCode }) => unknown) => sel({ setActiveCode }),
}));
// 탭 도입(D5): 행 클릭은 useJumpToLive → setActiveTabCode(code, label?)로 흐른다.
// 실제 liveTabs 모듈은 import 시 useLivePageStore.subscribe를 부르는데, 위 livePage
// 모킹은 selector만 제공하므로 모킹하지 않으면 모듈 로드가 crash 한다.
const { setActiveTabCode, openSymbolInNewTab } = vi.hoisted(() => ({
  setActiveTabCode: vi.fn(),
  openSymbolInNewTab: vi.fn(),
}));
vi.mock('../state/liveTabs', () => ({
  useLiveTabsStore: (sel: (s: {
    setActiveTabCode: typeof setActiveTabCode;
    openSymbolInNewTab: typeof openSymbolInNewTab;
  }) => unknown) => sel({ setActiveTabCode, openSymbolInNewTab }),
}));

import { Heatmap } from './Heatmap';
import { useHeatmapPrefsStore } from '../state/heatmapPrefs';
import { useLiveQuoteOverlay } from '../api/liveQuotes';

function renderPage() {
  const qc = new QueryClient();
  return render(<QueryClientProvider client={qc}><MemoryRouter><Heatmap /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  setActiveCode.mockClear();
  setActiveTabCode.mockClear();
  openSymbolInNewTab.mockClear();
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
  expect(await screen.findByTestId('heatmap-board')).toBeInTheDocument();
  expect(screen.queryByTestId('heatmap-nested-card')).not.toBeInTheDocument();
  expect((await screen.findAllByText('반도체')).length).toBeGreaterThanOrEqual(2);
  expect(screen.getByText('삼성전자')).toBeInTheDocument();
  expect(screen.getByText('● 장중')).toBeInTheDocument();
  expect(screen.queryByLabelText(/색 범례/)).toBeNull();   // #6: 범례 삭제
  expect(screen.getByRole('group', { name: '행 정렬' })).toBeInTheDocument();
  expect(screen.getByRole('group', { name: '그룹 정렬' })).toBeInTheDocument();
});

it('행 클릭 → 종목 탭 open-or-focus(jump-to-live)', async () => {
  renderPage();
  fireEvent.click(await screen.findByTestId('heatmap-row-005930'));
  expect(setActiveTabCode).toHaveBeenCalledWith('005930', '삼성전자');
});

it('Ctrl-clicking a heatmap row opens a new live tab', async () => {
  renderPage();
  fireEvent.click(await screen.findByTestId('heatmap-row-005930'), { ctrlKey: true });
  expect(openSymbolInNewTab).toHaveBeenCalledWith('005930', '삼성전자');
  expect(setActiveTabCode).not.toHaveBeenCalled();
});

it('Meta-clicking a heatmap row opens a new live tab', async () => {
  renderPage();
  fireEvent.click(await screen.findByTestId('heatmap-row-005930'), { metaKey: true });
  expect(openSymbolInNewTab).toHaveBeenCalledWith('005930', '삼성전자');
  expect(setActiveTabCode).not.toHaveBeenCalled();
});

it('기본 manual=order 순, 등락률↓ 토글 시 등락률 내림차순', async () => {
  renderPage();
  await screen.findAllByText('반도체');   // 스트립 칩+헤더로 중복 → All (렌더 대기용)
  const manual = screen.getAllByText(/삼성전자|SK하이닉스/).map((n) => n.textContent);
  expect(manual).toEqual(['삼성전자', 'SK하이닉스']);          // order 0,1
  fireEvent.click(screen.getByRole('button', { name: '등락률 ↓' }));
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

it('그룹 정렬 토글: aria로 쿼리, 클릭 시 store.groupSort 갱신(#7)', async () => {
  renderPage();
  await screen.findAllByText('반도체');
  expect(useHeatmapPrefsStore.getState().groupSort).toBe('manual');
  // 그룹 버튼은 aria-label 로 식별(visible text '등락률 ↓' 는 행 토글과 겹치므로)
  fireEvent.click(screen.getByRole('button', { name: '그룹을 평균 등락률 높은 순으로' }));
  expect(useHeatmapPrefsStore.getState().groupSort).toBe('desc');
  fireEvent.click(screen.getByRole('button', { name: '그룹 수동 순서' }));
  expect(useHeatmapPrefsStore.getState().groupSort).toBe('manual');
});
