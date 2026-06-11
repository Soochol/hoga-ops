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

// liveStatus: 기본 running:true → 배너 없음. 자격증명 배너 테스트에서만 override.
vi.mock('../api/liveStatus', async (orig) => ({
  ...(await orig<typeof import('../api/liveStatus')>()),
  useLiveStatus: vi.fn(() => ({ data: { running: true, started_at_ms: 1, cycle_lag_ms: 0 } })),
}));

const { setActiveCode } = vi.hoisted(() => ({ setActiveCode: vi.fn() }));
vi.mock('../state/livePage', () => ({
  useLivePageStore: (sel: (s: { setActiveCode: typeof setActiveCode }) => unknown) => sel({ setActiveCode }),
}));
// 탭 도입(D5): 행 클릭은 useJumpToLive → openOrFocusTab(code, label?)로 흐른다.
// 실제 liveTabs 모듈은 import 시 useLivePageStore.subscribe를 부르는데, 위 livePage
// 모킹은 selector만 제공하므로 모킹하지 않으면 모듈 로드가 crash 한다.
const { openOrFocusTab } = vi.hoisted(() => ({ openOrFocusTab: vi.fn() }));
vi.mock('../state/liveTabs', () => ({
  useLiveTabsStore: (sel: (s: { openOrFocusTab: typeof openOrFocusTab }) => unknown) => sel({ openOrFocusTab }),
}));

import { Heatmap } from './Heatmap';
import { useHeatmapPrefsStore } from '../state/heatmapPrefs';
import { useLiveStatus } from '../api/liveStatus';
import { useLiveQuoteOverlay } from '../api/liveQuotes';

function renderPage() {
  const qc = new QueryClient();
  return render(<QueryClientProvider client={qc}><MemoryRouter><Heatmap /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => {
  setActiveCode.mockClear();
  openOrFocusTab.mockClear();
  useHeatmapPrefsStore.setState({ sortMode: 'manual' });   // eng-review D2: 기본 manual
  Element.prototype.scrollIntoView = vi.fn();              // jsdom 미구현 — 스트립 점프 대비
  // 매 테스트 open 기본값으로 리셋 — per-test override가 다음 테스트로 누수되지 않게.
  vi.mocked(useLiveQuoteOverlay).mockReturnValue({
    quoteByCode: new Map([
      ['005930', { code: '005930', price: 70000, change_pct: -2, change_won: -1400 }],
      ['000660', { code: '000660', price: 200000, change_pct: 5, change_won: 10000 }],
    ]),
    phase: 'open', dataUpdatedAt: 0,
  } as ReturnType<typeof useLiveQuoteOverlay>);
  vi.mocked(useLiveStatus).mockReturnValue(
    { data: { running: true, started_at_ms: 1, cycle_lag_ms: 0 } } as ReturnType<typeof useLiveStatus>,
  );
});

it('폴더·종목·phase 배지·색 범례 렌더', async () => {
  renderPage();
  // 스트립 칩 + 폴더 헤더 둘 다 '반도체' → 2개 이상
  expect((await screen.findAllByText('반도체')).length).toBeGreaterThanOrEqual(2);
  expect(screen.getByText('삼성전자')).toBeInTheDocument();
  expect(screen.getByText('● 장중')).toBeInTheDocument();  // phase 배지(캡션 '장중 추세'와 구분)
  expect(screen.getByLabelText(/색 범례/)).toBeInTheDocument();   // spec §8 색 범례 바
});

it('행 클릭 → 종목 탭 open-or-focus(jump-to-live)', async () => {
  renderPage();
  fireEvent.click(await screen.findByTestId('heatmap-row-005930'));
  expect(openOrFocusTab).toHaveBeenCalledWith('005930', undefined);
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

it('관심종목 있는데 KIS 자격증명 없으면(poller 미기동) 배너', async () => {
  vi.mocked(useLiveStatus).mockReturnValue(
    { data: { running: false, started_at_ms: null, cycle_lag_ms: 0 } } as ReturnType<typeof useLiveStatus>,
  );
  renderPage();
  expect(await screen.findByText('KIS 자격증명이 설정되지 않았습니다')).toBeInTheDocument();
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
