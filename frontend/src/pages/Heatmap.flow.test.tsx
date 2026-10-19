import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';

const { apiCall } = vi.hoisted(() => ({ apiCall: vi.fn() }));
vi.mock('../api/client', () => ({ apiCall, apiAction: vi.fn() }));
vi.mock('../api/heatmap', async (original) => ({
  ...await original<typeof import('../api/heatmap')>(),
  getHeatmap: vi.fn(async () => ({
    folders: Array.from({ length: 7 }, (_, i) => ({ id: `f${i}`, name: `그룹${i}`, order: i })),
    entries: [{ code: '005930', name: '삼성전자', folder_id: 'f0', order: 0 }],
  })),
}));
vi.mock('../api/liveQuotes', async (original) => ({
  ...await original<typeof import('../api/liveQuotes')>(),
  useLiveQuoteOverlay: () => ({ quoteByCode: new Map(), phase: 'open', dataUpdatedAt: 0 }),
}));
vi.mock('../live/liveNavigate', () => ({ activateLiveCode: vi.fn(), activateLiveInstrument: vi.fn(), openLiveInNewTab: vi.fn() }));

import { Heatmap } from './Heatmap';
import { useHeatmapFlowPrefsStore } from '../state/heatmapFlowPrefs';
import { useLiveVenueStore } from '../state/liveVenue';
import { HEATMAP_KEY, invalidateHeatmapDependents } from '../heatmap/heatmapKeys';

const BASE = Date.parse('2026-10-19T09:00:00+09:00');
const FLOW = {
  date: '2026-10-19', bucket_ms: 300_000, t_base_ms: BASE,
  groups: Array.from({ length: 7 }, (_, i) => ({ folder_id: `f${i}`, pct: [i, i + 1, null, i + 3, ...Array<null>(74).fill(null)] })),
};
function Navigation() {
  const location = useLocation();
  const navigate = useNavigate();
  return <><output data-testid="location">{location.pathname}{location.search}</output><button onClick={() => navigate(-1)}>이전 화면</button></>;
}
function renderPage(path = '/heatmap?keep=yes') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { qc, ...render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={[path]}><Navigation /><Heatmap /></MemoryRouter></QueryClientProvider>) };
}
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useHeatmapFlowPrefsStore.setState({ selectedGroupIds: null, mode: 'absolute' });
  useLiveVenueStore.setState({ venue: 'KRX' });
  apiCall.mockImplementation(async (path: string) => path.startsWith('/api/heatmap/group-flow') ? FLOW : {});
});

it('기존 보드를 유지한 채 집중 보기로 전환하고, 같은 flow 조회를 공유하며 뒤로 가기를 지원한다', async () => {
  renderPage();
  const board = await screen.findByTestId('heatmap-board');
  const search = screen.getByTestId('heatmap-search');
  fireEvent.change(search, { target: { value: '삼성' } });
  fireEvent.click(screen.getByRole('button', { name: '흐름 비교' }));
  const comparison = await screen.findByTestId('heatmap-flow-comparison');
  expect(screen.getByTestId('location')).toHaveTextContent('/heatmap?keep=yes&view=flow');
  expect(board).not.toBeVisible();
  await waitFor(() => expect(within(comparison).getByTestId('flow-readout-f0')).toHaveTextContent('+3.00%'));
  const path = within(comparison).getByTestId('flow-line-f0').getAttribute('d')!;
  expect(path.match(/M/g)).toHaveLength(2); // 결측 앞뒤를 이어 그리지 않는다.
  fireEvent.click(screen.getByRole('button', { name: '이전 화면' }));
  expect(board).toBeVisible();
  expect(search).toHaveValue('삼성');
  expect(screen.queryByTestId('heatmap-flow-comparison')).toBeNull();
  const requests = apiCall.mock.calls.filter(([path]) => String(path).startsWith('/api/heatmap/group-flow'));
  expect(requests).toHaveLength(1);
});

it('그룹과 비교 기준은 화면을 왕복해도 유지하고 최대 여섯 그룹을 선택한다', async () => {
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: '흐름 비교' }));
  fireEvent.click(screen.getByRole('button', { name: '그룹0 비교에서 제외' }));
  fireEvent.click(screen.getByRole('button', { name: '그룹 선택' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '그룹6' }));
  expect(screen.getByRole('checkbox', { name: '그룹0' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '첫 구간 대비' }));
  fireEvent.click(screen.getByRole('button', { name: /히트맵으로 돌아가기/ }));
  fireEvent.click(screen.getByRole('button', { name: '흐름 비교' }));
  expect(screen.getByRole('button', { name: '첫 구간 대비' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: '그룹6 비교에서 제외' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '그룹0 비교에서 제외' })).toBeNull();
  expect(JSON.parse(localStorage.getItem('heatmap.flowComparison.v1')!)).toMatchObject({ mode: 'relative', selectedGroupIds: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'] });
});

it('딥링크·선택 거래소를 지원하고, 선택 시각에 결측이면 — 를 표시한다', async () => {
  useHeatmapFlowPrefsStore.setState({ selectedGroupIds: ['f0'], mode: 'absolute' });
  useLiveVenueStore.setState({ venue: 'NXT' });
  renderPage('/heatmap?view=flow');
  await screen.findByText('2026-10-19 · NXT · 그룹 구성 종목의 평균 등락률');
  const slider = screen.getByRole('slider', { name: '비교 시각 선택' });
  fireEvent.change(slider, { target: { value: BASE + 2 * 300_000 } });
  expect(screen.getByTestId('flow-readout-f0')).toHaveTextContent('—');
  expect(slider).toHaveAttribute('aria-valuetext', '09:10');
  expect(apiCall).toHaveBeenCalledWith('/api/heatmap/group-flow?venue=NXT');
});

it('히트맵을 보는 동안 다른 탭에서 저장한 마지막 그룹을 비교 진입 시 복원한다', async () => {
  renderPage();
  await screen.findByTestId('heatmap-board');
  localStorage.setItem('heatmap.flowComparison.v1', JSON.stringify({ selectedGroupIds: ['f6', 'f2'], mode: 'momentum' }));
  fireEvent.click(screen.getByRole('button', { name: '흐름 비교' }));
  expect(screen.getByRole('button', { name: '그룹6 비교에서 제외' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '그룹2 비교에서 제외' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '그룹0 비교에서 제외' })).toBeNull();
  expect(screen.getByRole('button', { name: '최근 30분 변화' })).toHaveAttribute('aria-pressed', 'true');
});

it('삭제된 그룹을 무시하고 명시적으로 비운 선택은 자동 선택으로 되돌리지 않는다', async () => {
  useHeatmapFlowPrefsStore.setState({ selectedGroupIds: ['deleted'], mode: 'absolute' });
  renderPage('/heatmap?view=flow');
  expect(await screen.findByText('그룹 선택에서 비교할 그룹을 골라 주세요.')).toBeInTheDocument();
  expect(screen.queryByRole('slider')).toBeNull();
});

it('그룹 편집 시 문서와 flow 캐시를 함께 무효화한다', async () => {
  const { qc } = renderPage();
  await screen.findByTestId('heatmap-board');
  await waitFor(() => expect(qc.getQueryData(['heatmap-group-flow', 'KRX'])).toBeDefined());
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  invalidateHeatmapDependents(qc);
  expect(invalidate).toHaveBeenCalledWith({ queryKey: HEATMAP_KEY });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['heatmap-group-flow'] });
});

it('flow 실패는 기존 히트맵을 막지 않으며 비교 화면에서 재시도할 수 있다', async () => {
  apiCall.mockRejectedValue(new Error('offline'));
  renderPage();
  expect(await screen.findByTestId('heatmap-board')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '흐름 비교' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('그룹별 흐름을 불러오지 못했습니다.');
  apiCall.mockResolvedValue(FLOW);
  fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
  expect(await screen.findByTestId('flow-readout-f0')).toHaveTextContent('+3.00%');
});
