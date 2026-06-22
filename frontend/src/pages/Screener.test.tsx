import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { it, expect, vi, afterEach } from 'vitest';

vi.mock('../api/screener', async (orig) => ({
  ...(await orig<typeof import('../api/screener')>()),
  runScan: vi.fn(() => Promise.resolve({ status: 'ok', warnings: [], rows: [
    { code: '005930', name: '삼성전자', market: 'KOSPI', price: 74200, trade_value_won: 842_000_000_000, change_pct: 5.8 },
    { code: '000660', name: 'SK하이닉스', market: 'KOSPI', price: 180000, trade_value_won: 600_000_000_000, change_pct: -1.2 },
    { code: '035420', name: 'NAVER', market: 'KOSPI', price: 210000, trade_value_won: 300_000_000_000, change_pct: 2.4 },
  ] })),
  getScreenerStatus: vi.fn(() => Promise.resolve({ status: 'ok', last_raw_date: '20260530', days_behind: 0 })),
  triggerScreenerUpdate: vi.fn(),
}));
vi.mock('../api/savedScreeners', () => ({
  listSaves: vi.fn(() => Promise.resolve({ schema_version: 1, saves: [] })),
  createSave: vi.fn(), updateSave: vi.fn(), deleteSave: vi.fn(),
}));
// 라이브 오버레이는 결과 행의 현재가·등락률을 덮는다. 기본 빈 Map(오버레이 없음)으로
// 두어 EOD 검증 테스트를 보존하고, 오버레이 테스트에서만 quote 를 주입한다.
vi.mock('../api/liveQuotes', () => ({ useQuoteByCode: vi.fn(() => new Map()) }));

// useLivePageStore lives at ../state/livePage (the path LiveStatusBar imports);
// `../live/useLivePageStore` does not exist. Mock the real module so clicking a
// row drives the real selector. vi.hoisted avoids the TDZ ReferenceError that a
// bare `const setActiveCode = vi.fn()` referenced inside the hoisted factory
// would otherwise throw.
const { setActiveCode } = vi.hoisted(() => ({ setActiveCode: vi.fn() }));
vi.mock('../state/livePage', () => ({
  useLivePageStore: (sel: (s: { setActiveCode: typeof setActiveCode }) => unknown) =>
    sel({ setActiveCode }),
}));
// 단일-탭 모델(ADR-0069 개정): 행 클릭은 useJumpToLive → setActiveTabCode(code, label?)로 흐른다.
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

import { Screener } from './Screener';
import { runScan } from '../api/screener';
import { listSaves, createSave, updateSave } from '../api/savedScreeners';
import { useQuoteByCode } from '../api/liveQuotes';
import type { SavedScreener } from '../api/savedScreeners';

// 오버레이 테스트가 주입한 quote 가 다음 테스트로 새지 않도록 매 테스트 후 빈 Map 복구.
afterEach(() => {
  vi.mocked(useQuoteByCode).mockReturnValue(new Map());
  setActiveTabCode.mockClear();
  openSymbolInNewTab.mockClear();
});

function renderPage() {
  const qc = new QueryClient();
  return render(<QueryClientProvider client={qc}><MemoryRouter><Screener /></MemoryRouter></QueryClientProvider>);
}

function resultNames() {
  return screen.getAllByRole('button', { name: /호가창 열기/ }).map((row) => row.getAttribute('aria-label') ?? '');
}

function sortButton() {
  return screen.getByRole('button', { name: '스크리너 결과 정렬' });
}

it('조회 결과 액션에는 관심 그룹 하트만 표시한다', async () => {
  renderPage();
  fireEvent.click(screen.getByText('조회'));
  await screen.findByText('삼성전자');
  const row = screen.getByRole('button', { name: '삼성전자 005930 호가창 열기' });
  expect(within(row).getByRole('button', { name: '관심 그룹 편집' })).toBeInTheDocument();
  expect(within(row).queryByRole('button', { name: '캡처 페이지 열기' })).not.toBeInTheDocument();
});

it('runs scan and renders row; click sets the active tab code', async () => {
  renderPage();
  fireEvent.click(screen.getByText('조회'));
  await waitFor(() => screen.getByText('삼성전자'));
  fireEvent.click(screen.getByText('삼성전자'));
  expect(setActiveTabCode).toHaveBeenCalledWith('005930', '삼성전자');
});

it('Ctrl-clicking a row opens the result in a new live tab', async () => {
  renderPage();
  fireEvent.click(screen.getByText('조회'));
  await waitFor(() => screen.getByText('삼성전자'));
  fireEvent.click(screen.getByText('삼성전자'), { ctrlKey: true });
  expect(openSymbolInNewTab).toHaveBeenCalledWith('005930', '삼성전자');
  expect(setActiveTabCode).not.toHaveBeenCalled();
});

it('Meta-clicking a row opens the result in a new live tab', async () => {
  renderPage();
  fireEvent.click(screen.getByText('조회'));
  await waitFor(() => screen.getByText('삼성전자'));
  fireEvent.click(screen.getByText('삼성전자'), { metaKey: true });
  expect(openSymbolInNewTab).toHaveBeenCalledWith('005930', '삼성전자');
  expect(setActiveTabCode).not.toHaveBeenCalled();
});

it('row is keyboard-activatable', async () => {
  renderPage();
  fireEvent.click(screen.getByText('조회'));
  const row = await screen.findByText('삼성전자');
  fireEvent.keyDown(row.closest('[role="button"]')!, { key: 'Enter' });
  expect(setActiveTabCode).toHaveBeenCalledWith('005930', '삼성전자');
});

it('sorts full-page screener results and resets to default on re-scan', async () => {
  renderPage();
  fireEvent.click(screen.getByRole('button', { name: '조회' }));
  await screen.findByText('삼성전자');

  expect(resultNames()).toEqual([
    '삼성전자 005930 호가창 열기',
    'SK하이닉스 000660 호가창 열기',
    'NAVER 035420 호가창 열기',
  ]);

  fireEvent.click(sortButton());
  expect(resultNames()).toEqual([
    '삼성전자 005930 호가창 열기',
    'NAVER 035420 호가창 열기',
    'SK하이닉스 000660 호가창 열기',
  ]);

  fireEvent.click(sortButton());
  expect(resultNames()).toEqual([
    'SK하이닉스 000660 호가창 열기',
    'NAVER 035420 호가창 열기',
    '삼성전자 005930 호가창 열기',
  ]);

  fireEvent.click(sortButton());
  expect(resultNames()).toEqual([
    '삼성전자 005930 호가창 열기',
    'SK하이닉스 000660 호가창 열기',
    'NAVER 035420 호가창 열기',
  ]);

  fireEvent.click(sortButton());
  expect(within(sortButton()).getByTestId('sort-icon-desc')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '조회' }));
  await waitFor(() => expect(within(sortButton()).getByTestId('sort-icon-default')).toBeInTheDocument());
  expect(resultNames()).toEqual([
    '삼성전자 005930 호가창 열기',
    'SK하이닉스 000660 호가창 열기',
    'NAVER 035420 호가창 열기',
  ]);
});

it('sorts by overlayed live change_pct when present', async () => {
  vi.mocked(useQuoteByCode).mockReturnValue(new Map([
    ['005930', { code: '005930', price: 80000, change_pct: 7.7, change_won: 5000 }],
    ['000660', { code: '000660', price: 176000, change_pct: -9.8, change_won: -19000 }],
    ['035420', { code: '035420', price: 200000, change_pct: 12.5, change_won: 25000 }],
  ]));

  renderPage();
  fireEvent.click(screen.getByRole('button', { name: '조회' }));
  await screen.findByText('삼성전자');

  fireEvent.click(sortButton());
  expect(resultNames()).toEqual([
    'NAVER 035420 호가창 열기',
    '삼성전자 005930 호가창 열기',
    'SK하이닉스 000660 호가창 열기',
  ]);

  fireEvent.click(sortButton());
  expect(resultNames()).toEqual([
    'SK하이닉스 000660 호가창 열기',
    '삼성전자 005930 호가창 열기',
    'NAVER 035420 호가창 열기',
  ]);
});

it('keeps the full-page sort control disabled for empty scan results', async () => {
  vi.mocked(runScan).mockResolvedValueOnce({ status: 'ok', warnings: [], rows: [] });

  renderPage();
  fireEvent.click(screen.getByRole('button', { name: '조회' }));

  await waitFor(() => expect(runScan).toHaveBeenCalled());
  expect(screen.queryByRole('button', { name: /호가창 열기/ })).not.toBeInTheDocument();
  expect(sortButton()).toBeDisabled();
});

it('surfaces a scan error instead of a silent dead-end', async () => {
  vi.mocked(runScan).mockRejectedValueOnce(new Error('422'));
  renderPage();
  fireEvent.click(screen.getByText('조회'));
  expect(await screen.findByText('조회 실패 — 조건을 확인하세요')).toBeInTheDocument();
});

it('selecting a saved screener loads it without running a scan', async () => {
  vi.mocked(listSaves).mockResolvedValueOnce({ schema_version: 1, saves: [
    { id: 's1', name: '급등주', conditions: [], universe: {}, created_at_ms: 1, updated_at_ms: 1 }] });
  vi.mocked(runScan).mockClear();
  renderPage();
  const item = await screen.findByText('급등주');
  fireEvent.click(item);
  // select = load-into-builder only; scan happens only on 조회 click (ADR/spec).
  expect(runScan).not.toHaveBeenCalled();
});

it('toolbar save overwrites the loaded screener with the current builder', async () => {
  const saved: SavedScreener = {
    id: 's1', name: '급등주',
    conditions: [], universe: {}, created_at_ms: 1, updated_at_ms: 1,
  };
  vi.mocked(listSaves).mockResolvedValueOnce({ schema_version: 1, saves: [saved] });
  vi.mocked(updateSave).mockResolvedValueOnce({ ...saved, universe: { exclude_etf: true } });
  renderPage();

  fireEvent.click(await screen.findByText('급등주'));
  fireEvent.click(screen.getByRole('button', { name: /사전필터/ }));
  fireEvent.click(screen.getByRole('button', { name: '제외' }));
  fireEvent.click(screen.getByLabelText('ETF 제외'));
  fireEvent.click(screen.getByRole('button', { name: '저장' }));

  await waitFor(() => expect(updateSave).toHaveBeenCalledWith('s1', {
    name: '급등주',
    conditions: [],
    universe: { exclude_etf: true },
  }));
});

it('toolbar save creates a new screener when there is no loaded save', async () => {
  const created: SavedScreener = {
    id: 'new1', name: '새전략',
    conditions: [], universe: {}, created_at_ms: 2, updated_at_ms: 2,
  };
  vi.mocked(createSave).mockResolvedValueOnce(created);
  renderPage();

  fireEvent.click(screen.getByRole('button', { name: '저장' }));
  const dialog = await screen.findByRole('dialog', { name: '조건검색 저장' });
  fireEvent.change(screen.getByLabelText('조건검색 이름'), { target: { value: '새전략' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '저장' }));

  await waitFor(() => expect(createSave).toHaveBeenCalledWith({
    name: '새전략',
    conditions: [],
    universe: {},
  }));
});

it('toolbar save-as always creates a new screener from the current builder', async () => {
  const saved: SavedScreener = {
    id: 's1', name: '급등주',
    conditions: [], universe: {}, created_at_ms: 1, updated_at_ms: 1,
  };
  vi.mocked(listSaves).mockResolvedValueOnce({ schema_version: 1, saves: [saved] });
  vi.mocked(createSave).mockResolvedValueOnce({ ...saved, id: 'copy1', name: '복사본' });
  renderPage();

  fireEvent.click(await screen.findByText('급등주'));
  fireEvent.click(screen.getByRole('button', { name: '다른 이름으로 저장' }));
  const dialog = await screen.findByRole('dialog', { name: '조건검색 저장' });
  fireEvent.change(screen.getByLabelText('조건검색 이름'), { target: { value: '복사본' } });
  fireEvent.click(within(dialog).getByRole('button', { name: '저장' }));

  await waitFor(() => expect(createSave).toHaveBeenCalledWith({
    name: '복사본',
    conditions: [],
    universe: {},
  }));
});

it('marks scan results stale after builder edits, then clears after a new scan', async () => {
  renderPage();
  fireEvent.click(screen.getByRole('button', { name: '조회' }));
  await screen.findByText('삼성전자');

  fireEvent.click(screen.getByRole('button', { name: /사전필터/ }));
  fireEvent.click(screen.getByRole('button', { name: '제외' }));
  fireEvent.click(screen.getByLabelText('ETF 제외'));
  expect(await screen.findByText('조건 변경됨 · 다시 조회 필요')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: '조회' }));
  await waitFor(() => expect(screen.queryByText('조건 변경됨 · 다시 조회 필요')).not.toBeInTheDocument());
});

it('anchors a loaded screener as clean, then marks 수정됨 once the builder is edited (C4)', async () => {
  // Pins the load-vs-edit setter routing: loading must NOT flip dirty (else the
  // marker would show immediately, before any edit), and a real edit must.
  vi.mocked(listSaves).mockResolvedValueOnce({ schema_version: 1, saves: [
    { id: 's1', name: '급등주', conditions: [], universe: {}, created_at_ms: 1, updated_at_ms: 1 }] });
  renderPage();
  fireEvent.click(await screen.findByText('급등주'));        // load → anchored, clean
  expect(screen.queryByText('수정됨')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /사전필터/ }));  // 모달 열기
  fireEvent.click(screen.getByRole('button', { name: '제외' }));      // 제외 그룹 pane
  fireEvent.click(screen.getByLabelText('ETF 제외'));                 // edit a global pre-filter
  expect((await screen.findAllByText('수정됨')).length).toBeGreaterThanOrEqual(1);
});

it('does not lie "clean" when the builder is edited while a create is in flight (C4 race)', async () => {
  // The false-clean the adversarial pass found: on a slow save, an edit landing
  // mid-flight must keep the freshly-anchored row 수정됨, never reset it to clean.
  let resolveCreate!: (v: SavedScreener) => void;
  const created: SavedScreener = { id: 'new1', name: '레이스', conditions: [], universe: {}, created_at_ms: 2, updated_at_ms: 2 };
  vi.mocked(createSave).mockImplementationOnce(() => new Promise<SavedScreener>((r) => { resolveCreate = r; }));
  vi.mocked(listSaves).mockResolvedValue({ schema_version: 1, saves: [created] });

  renderPage();
  await screen.findByText('조회');                                      // 페이지 렌더 대기(항상 존재)
  fireEvent.click(screen.getByRole('button', { name: '새 조건검색' }));  // open inline editor
  const input = screen.getByLabelText('조건검색 이름');
  fireEvent.change(input, { target: { value: '레이스' } });
  fireEvent.blur(input);                                               // commit → onBeginSave + create.mutate
  fireEvent.click(screen.getByRole('button', { name: /사전필터/ }));    // 모달 열기 (create in-flight 중)
  fireEvent.click(screen.getByRole('button', { name: '제외' }));        // 제외 그룹 pane
  fireEvent.click(screen.getByLabelText('ETF 제외'));                   // edit DURING the in-flight create (bumps gen)
  await waitFor(() => expect(createSave).toHaveBeenCalled());
  resolveCreate(created);

  expect((await screen.findAllByText('수정됨')).length).toBeGreaterThanOrEqual(1);
  const row = screen.getAllByText('레이스').map((el) => el.closest('[role="button"]')).find(Boolean) as HTMLElement;
  expect(row.className)
    .not.toContain('bg-[rgba(20,184,166,0.14)]');
});

it('starts with an empty builder (no default 신고가 condition)', async () => {
  renderPage();
  // The seed condition used to render a 신고가 row. With an empty builder there
  // is no condition row and no AND label.
  expect(screen.queryByText('신고가')).not.toBeInTheDocument();
  expect(screen.queryByText('모두 충족 · AND')).not.toBeInTheDocument();
});

it('현재가·등락률을 라이브 quote 로 덮는다 (EOD 코퍼스 위 오버레이)', async () => {
  // 코퍼스(EOD): price 74,200 / pct 5.80% → 라이브: 80,000 / 7.70% 로 덮여야 한다.
  vi.mocked(useQuoteByCode).mockReturnValue(new Map([
    ['005930', { code: '005930', price: 80000, change_pct: 7.7, change_won: 5000 }],
  ]));
  renderPage();
  fireEvent.click(screen.getByText('조회'));
  await screen.findByText('삼성전자');
  expect(screen.getByText('80,000')).toBeInTheDocument();     // 라이브 현재가 (ResultTable: 원 suffix 없음)
  expect(screen.getByText('▲ +7.70%')).toBeInTheDocument();   // 라이브 등락률 (ChangeCell)
  expect(screen.queryByText('74,200')).not.toBeInTheDocument(); // 코퍼스 현재가는 덮여 사라짐
});
