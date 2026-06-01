import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { it, expect, vi } from 'vitest';

vi.mock('../api/screener', async (orig) => ({
  ...(await orig<typeof import('../api/screener')>()),
  runScan: vi.fn(() => Promise.resolve({ status: 'ok', warnings: [], rows: [
    { code: '005930', name: '삼성전자', market: 'KOSPI', price: 74200, trade_value_won: 842_000_000_000, change_pct: 5.8 }] })),
  getScreenerStatus: vi.fn(() => Promise.resolve({ status: 'ok', last_raw_date: '20260530', days_behind: 0 })),
  triggerScreenerUpdate: vi.fn(),
}));
vi.mock('../api/savedScreeners', () => ({
  listSaves: vi.fn(() => Promise.resolve({ schema_version: 1, saves: [] })),
  createSave: vi.fn(), updateSave: vi.fn(), deleteSave: vi.fn(),
}));

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

import { Screener } from './Screener';
import { runScan } from '../api/screener';
import { listSaves, createSave } from '../api/savedScreeners';
import type { SavedScreener } from '../api/savedScreeners';

function renderPage() {
  const qc = new QueryClient();
  return render(<QueryClientProvider client={qc}><MemoryRouter><Screener /></MemoryRouter></QueryClientProvider>);
}

it('runs scan and renders row; click sets activeCode', async () => {
  renderPage();
  fireEvent.click(screen.getByText('조회'));
  await waitFor(() => screen.getByText('삼성전자'));
  fireEvent.click(screen.getByText('삼성전자'));
  expect(setActiveCode).toHaveBeenCalledWith('005930');
});

it('row is keyboard-activatable', async () => {
  renderPage();
  fireEvent.click(screen.getByText('조회'));
  const row = await screen.findByText('삼성전자');
  fireEvent.keyDown(row.closest('[role="button"]')!, { key: 'Enter' });
  expect(setActiveCode).toHaveBeenCalledWith('005930');
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
  expect(await screen.findByText('수정됨')).toBeInTheDocument();
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

  expect(await screen.findByText('수정됨')).toBeInTheDocument();
  expect(screen.getByText('레이스').closest('[role="button"]')!.className)
    .not.toContain('bg-[rgba(20,184,166,0.14)]');
});

it('starts with an empty builder (no default 신고가 condition)', async () => {
  renderPage();
  // The seed condition used to render a 신고가 row. With an empty builder there
  // is no condition row and no AND label.
  expect(screen.queryByText('신고가')).not.toBeInTheDocument();
  expect(screen.queryByText('모두 충족 · AND')).not.toBeInTheDocument();
});
