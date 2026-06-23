import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ParquetStudySnapshot, ParquetStudyView } from '../api/studyViews';
import type { CurrentStudySaveSource } from './studySaveSource';
import { StudyViewsDrawer, filterStudyViews } from './StudyViewsDrawer';

const createMutate = vi.fn();
const updateMutate = vi.fn();
const updateMetadataMutate = vi.fn();
const removeMutate = vi.fn();
let saveSource: CurrentStudySaveSource | null = null;
let mockedSaves: ParquetStudyView[] = [];

const saves: ParquetStudyView[] = [
  {
    id: 'a',
    name: '급등 이후',
    code: '005930',
    label: '삼성전자',
    timeframe: '5m',
    memo: 'memo one',
    tags: [],
    snapshot_from_ms: 1_000,
    snapshot_to_ms: 2_000,
    viewport: { right_edge_ms: 2_000, bar_span: 200, at_live_edge: false },
    indicator_state: {
      volume_enabled: true,
      quote_totals_enabled: true,
      ratio_enabled: true,
      fill_strength_enabled: true,
      aggregation_basis: 'close',
      auction_window_mask: true,
      ratio_outlier_filter_enabled: true,
      ratio_outlier_threshold: 50,
    },
    provenance: { saved_from_route: '/study', data_provenance: 'study_snapshot' },
    snapshot_schema_version: 1,
    snapshot_path: 'a.json',
    snapshot_size_bytes: 100,
    created_at_ms: 1,
    updated_at_ms: 1,
  },
  {
    id: 'b',
    name: '눌림',
    code: '000660',
    label: 'SK하이닉스',
    timeframe: 'D',
    memo: 'space memo',
    tags: [],
    snapshot_from_ms: 1_000,
    snapshot_to_ms: 2_000,
    viewport: { right_edge_ms: 2_000, bar_span: 200, at_live_edge: false },
    indicator_state: {
      volume_enabled: true,
      quote_totals_enabled: true,
      ratio_enabled: true,
      fill_strength_enabled: true,
      aggregation_basis: 'close',
      auction_window_mask: true,
      ratio_outlier_filter_enabled: true,
      ratio_outlier_threshold: 50,
    },
    provenance: { saved_from_route: '/study', data_provenance: 'study_snapshot' },
    snapshot_schema_version: 1,
    snapshot_path: 'b.json',
    snapshot_size_bytes: 100,
    created_at_ms: 1,
    updated_at_ms: 1,
  },
];

vi.mock('./useStudyViews', () => ({
  useStudyViews: () => ({
    data: { schema_version: 1, saves: mockedSaves },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useStudyViewMutations: () => ({
    create: { mutate: createMutate },
    update: { mutate: updateMutate },
    updateMetadata: { mutate: updateMetadataMutate, isPending: false, error: null },
    remove: { mutate: removeMutate },
  }),
}));

vi.mock('./studySaveSource', () => ({
  useCurrentStudySaveSource: () => saveSource,
}));

function snapshotFixture(): ParquetStudySnapshot {
  return {
    schema_version: 1,
    source_policy: 'fixed',
    code: '005930',
    label: '삼성전자',
    timeframe: '5m',
    snapshot_from_ms: 1_000,
    snapshot_to_ms: 2_000,
    bucket_kind: '5m',
    viewport: { right_edge_ms: 2_000, bar_span: 200, at_live_edge: false },
    indicator_state: saves[0].indicator_state,
    provenance: { saved_from_route: '/study', data_provenance: 'study_snapshot' },
    bundle: {
      code: '005930',
      timeframe: '5m',
      snapshot_from_ms: 1_000,
      snapshot_to_ms: 2_000,
      segments: [{ date: '20260616', session_open_ms: 1_000, session_close_ms: 2_000 }],
      candles: [
        { t: 1_000, open: 1, high: 2, low: 1, close: 2, volume: 10 },
        { t: 2_000, open: 2, high: 3, low: 2, close: 3, volume: 11 },
      ],
      quote_totals: [{ t: 1_000, bid_total: 100, ask_total: 90, visible: true }],
      ratio: [{ t: 1_000, value: 0.1, visible: true }],
      fill_strength: [{ t: 1_000, buy_qty: 5, sell_qty: 4, visible: true }],
      ask_peaks: [],
      data_warnings: [],
    },
    captured_at_ms: 3_000,
  };
}

function rangeBundleFixture() {
  return {
    code: '005930',
    from_date: '20260616',
    to_date: '20260616',
    bucket_ms: 300_000,
    segments: [{ date: '20260616', session_open_ms: 1_000, session_close_ms: 2_000 }],
    candles: [
      { ts_ms: 1_000, open: 1, high: 2, low: 1, close: 2, vol_a: 10, vol_b: 0 },
      { ts_ms: 2_000, open: 2, high: 3, low: 2, close: 3, vol_a: 11, vol_b: 0 },
    ],
    quote_ratio: {
      bucket_ms: 300_000,
      points: [{ t: 1_000, bid_total: 100, ask_total: 90, bid_max: 0, ask_max: 0, imb_max_bid: 0, imb_max_ask: 0 }],
    },
    study_ratio: { bucket_ms: 300_000, points: [{ t: 1_000, value: 0.1 }] },
    fill_strength: { bucket_ms: 300_000, points: [{ t: 1_000, buy_qty: 5, sell_qty: 4 }] },
    volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_by_day: [],
    investorPoints: [],
    ask_peaks: [],
  };
}

function renderDrawer(path: string) {
  const qc = new QueryClient();
  const Location = () => <div data-testid="loc">{useLocation().pathname}{useLocation().search}</div>;
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="*" element={<><StudyViewsDrawer /><Location /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  createMutate.mockReset();
  updateMutate.mockReset();
  updateMetadataMutate.mockReset();
  removeMutate.mockReset();
  saveSource = null;
  mockedSaves = saves;
});

it('filters by name, code, and memo ignoring whitespace and case', () => {
  const rows = [
    { name: 'My View', code: '005930', memo: 'hello world' },
    { name: 'Other', code: '000660', memo: 'nothing' },
  ];
  expect(filterStudyViews(rows, 'myview')).toHaveLength(1);
  expect(filterStudyViews(rows, '005 930')).toHaveLength(1);
  expect(filterStudyViews(rows, 'HELLO WORLD')).toHaveLength(1);
});

it('renders list and no-match state', async () => {
  renderDrawer('/inventory');
  expect(screen.getByText('급등 이후')).toBeTruthy();
  await userEvent.type(screen.getByLabelText('저장 뷰 검색'), '없음');
  expect(screen.getByText('검색 결과가 없습니다.')).toBeTruthy();
  expect(screen.queryByText('차트 화면에서 저장할 수 있습니다.')).toBeNull();
});

it('renders saved views as Code-keyed stock-name tree groups', () => {
  mockedSaves = [
    ...saves,
    { ...saves[0], id: 'c', name: '종가 반등', memo: 'close rebound', updated_at_ms: 2 },
    { ...saves[0], id: 'd', code: '123456', name: '동명이종목', memo: 'same label', updated_at_ms: 3 },
  ];

  renderDrawer('/inventory');

  const samsung = screen.getByRole('region', { name: '삼성전자 005930 저장뷰' });
  expect(within(samsung).getByRole('button', { name: '삼성전자 005930 접기' })).toHaveAttribute('aria-expanded', 'true');
  expect(within(samsung).getByTitle('삼성전자 005930')).toBeTruthy();
  expect(within(samsung).getByRole('button', { name: '급등 이후 저장뷰 열기' })).toBeTruthy();
  expect(within(samsung).queryByText('삼성전자 005930 · 5m')).toBeNull();
  expect(within(samsung).getByRole('button', { name: '종가 반등 저장뷰 열기' })).toBeTruthy();

  const sameLabelOtherCode = screen.getByRole('region', { name: '삼성전자 123456 저장뷰' });
  expect(within(sameLabelOtherCode).getByRole('button', { name: '동명이종목 저장뷰 열기' })).toBeTruthy();
});

it('matches watchlist list typography for stock headers and saved view names', () => {
  renderDrawer('/inventory');

  const groupHeader = screen.getByRole('button', { name: '삼성전자 005930 접기' });
  expect(groupHeader).toHaveClass('text-xs');
  expect(groupHeader).toHaveClass('text-fg');
  expect(groupHeader).not.toHaveClass('text-sm');

  const savedViewName = screen.getByText('급등 이후');
  expect(savedViewName).toHaveClass('text-xs');
  expect(savedViewName).toHaveClass('text-fg');
  expect(savedViewName).not.toHaveClass('text-sm');
});

it('collapses and expands one stock group', async () => {
  renderDrawer('/inventory');

  await userEvent.click(screen.getByRole('button', { name: '삼성전자 005930 접기' }));

  expect(screen.getByRole('button', { name: '삼성전자 005930 펼치기' })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('button', { name: '급등 이후 저장뷰 열기' })).toBeNull();

  await userEvent.click(screen.getByRole('button', { name: '삼성전자 005930 펼치기' }));

  expect(screen.getByRole('button', { name: '삼성전자 005930 접기' })).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('button', { name: '급등 이후 저장뷰 열기' })).toBeTruthy();
});

it('renders new unpersisted stock groups expanded by default', () => {
  window.localStorage.setItem('studyViews.collapsedGroups.v1', JSON.stringify({ keys: ['005930'] }));
  mockedSaves = [
    ...saves,
    { ...saves[0], id: 'c', code: '111111', label: '새종목', name: '새 저장뷰', updated_at_ms: 2 },
  ];

  renderDrawer('/inventory');

  expect(screen.queryByRole('button', { name: '급등 이후 저장뷰 열기' })).toBeNull();
  expect(screen.getByRole('button', { name: '새 저장뷰 저장뷰 열기' })).toBeTruthy();
});

it('searches stock name and shows all saved views under matching Code groups', async () => {
  mockedSaves = [
    ...saves,
    { ...saves[0], id: 'c', name: '종가 반등', memo: 'close rebound', updated_at_ms: 2 },
  ];
  renderDrawer('/inventory');

  await userEvent.type(screen.getByLabelText('저장 뷰 검색'), '삼성');

  expect(screen.getByRole('button', { name: '삼성전자 005930 접기' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '급등 이후 저장뷰 열기' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '종가 반등 저장뷰 열기' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'SK하이닉스 000660 접기' })).toBeNull();
});

it('searches Code and shows the full matching Code group', async () => {
  mockedSaves = [
    ...saves,
    { ...saves[0], id: 'c', name: '종가 반등', memo: 'close rebound', updated_at_ms: 2 },
  ];
  renderDrawer('/inventory');

  await userEvent.type(screen.getByLabelText('저장 뷰 검색'), '005 930');

  expect(screen.getByRole('button', { name: '급등 이후 저장뷰 열기' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '종가 반등 저장뷰 열기' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: '눌림 저장뷰 열기' })).toBeNull();
});

it('searches saved-view fields and shows only matching child rows', async () => {
  mockedSaves = [
    ...saves,
    { ...saves[0], id: 'c', name: '종가 반등', memo: 'close rebound', updated_at_ms: 2 },
  ];
  renderDrawer('/inventory');

  await userEvent.type(screen.getByLabelText('저장 뷰 검색'), 'close rebound');

  expect(screen.getByRole('button', { name: '삼성전자 005930 접기' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: '급등 이후 저장뷰 열기' })).toBeNull();
  expect(screen.getByRole('button', { name: '종가 반등 저장뷰 열기' })).toBeTruthy();
});

it('respects collapsed groups during search', async () => {
  renderDrawer('/inventory');

  await userEvent.click(screen.getByRole('button', { name: '삼성전자 005930 접기' }));
  await userEvent.type(screen.getByLabelText('저장 뷰 검색'), '삼성');

  expect(screen.getByRole('button', { name: '삼성전자 005930 펼치기' })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('button', { name: '급등 이후 저장뷰 열기' })).toBeNull();
});

it('collapses and expands all visible stock groups immediately', async () => {
  renderDrawer('/inventory');

  await userEvent.click(screen.getByRole('button', { name: '전체 접기' }));

  expect(screen.getByRole('button', { name: '삼성전자 005930 펼치기' })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.getByRole('button', { name: 'SK하이닉스 000660 펼치기' })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('button', { name: '급등 이후 저장뷰 열기' })).toBeNull();
  expect(screen.queryByRole('button', { name: '눌림 저장뷰 열기' })).toBeNull();

  await userEvent.click(screen.getByRole('button', { name: '전체 펼치기' }));

  expect(screen.getByRole('button', { name: '삼성전자 005930 접기' })).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('button', { name: 'SK하이닉스 000660 접기' })).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('button', { name: '급등 이후 저장뷰 열기' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '눌림 저장뷰 열기' })).toBeTruthy();
});

it('bulk controls affect filtered visible groups without changing hidden groups', async () => {
  renderDrawer('/inventory');

  await userEvent.type(screen.getByLabelText('저장 뷰 검색'), 'SK');
  await userEvent.click(screen.getByRole('button', { name: '전체 접기' }));
  await userEvent.clear(screen.getByLabelText('저장 뷰 검색'));

  expect(screen.getByRole('button', { name: '삼성전자 005930 접기' })).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('button', { name: '급등 이후 저장뷰 열기' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'SK하이닉스 000660 펼치기' })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('button', { name: '눌림 저장뷰 열기' })).toBeNull();
});

it('moves the live save action out of the drawer', () => {
  saveSource = {
    origin: 'live',
    code: '005930',
    label: '삼성전자',
    timeframe: '5m',
    bundle: rangeBundleFixture(),
    indicatorState: saves[0].indicator_state,
    captureViewport: () => ({ rightEdgeMs: 2_000, barSpan: 2, atLiveEdge: true }),
  };
  renderDrawer('/live');

  expect(screen.queryByRole('button', { name: '현재 뷰 저장' })).toBeNull();
  expect(screen.queryByText('라이브 상단 툴바에서 저장할 수 있습니다.')).toBeNull();
});

it('does not show the secondary new-save action in the drawer body', () => {
  const snapshot = snapshotFixture();
  saveSource = {
    origin: 'study',
    viewId: 'a',
    snapshot,
    bundle: rangeBundleFixture(),
    captureViewport: () => ({ rightEdgeMs: 2_000, barSpan: 2, atLiveEdge: false }),
  };
  renderDrawer('/study?view=a');

  expect(screen.queryByRole('button', { name: '새 저장본 만들기' })).toBeNull();
});

it('opens overwrite dialog from current study view primary action', async () => {
  saveSource = {
    origin: 'study',
    viewId: 'a',
    snapshot: snapshotFixture(),
    bundle: rangeBundleFixture(),
    captureViewport: () => null,
  };
  renderDrawer('/study?view=a');

  await userEvent.click(screen.getByRole('button', { name: '덮어쓰기' }));
  expect(screen.getByRole('dialog', { name: '저장뷰 덮어쓰기' })).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: '저장' }));

  expect(updateMutate).toHaveBeenCalledTimes(1);
  expect(updateMutate.mock.calls[0][0].id).toBe('a');
  expect(updateMutate.mock.calls[0][0].body.name).toBe('급등 이후');
});

it('overwrites the current study source even when the saves list is missing the row', async () => {
  mockedSaves = [saves[1]];
  saveSource = {
    origin: 'study',
    viewId: 'missing-current',
    snapshot: snapshotFixture(),
    bundle: rangeBundleFixture(),
    captureViewport: () => null,
  };
  renderDrawer('/study?view=missing-current');

  await userEvent.click(screen.getByRole('button', { name: '덮어쓰기' }));
  expect(screen.getByRole('dialog', { name: '저장뷰 덮어쓰기' })).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: '저장' }));

  expect(updateMutate).toHaveBeenCalledTimes(1);
  expect(createMutate).not.toHaveBeenCalled();
  expect(updateMutate.mock.calls[0][0].id).toBe('missing-current');
  expect(updateMutate.mock.calls[0][0].body.name).toBe('삼성전자 5m 저장뷰');
});

it('clicking the saved view title navigates to the study route', async () => {
  renderDrawer('/inventory');

  await userEvent.click(screen.getByRole('button', { name: '급등 이후 저장뷰 열기' }));

  await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/study?view=a'));
});

it('pressing Enter on the saved view title navigates to the study route', async () => {
  renderDrawer('/inventory');

  const titleButton = screen.getByRole('button', { name: '급등 이후 저장뷰 열기' });
  titleButton.focus();
  await userEvent.keyboard('{Enter}');

  await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/study?view=a'));
});

it('does not render persistent row edit or delete buttons', () => {
  renderDrawer('/inventory');

  expect(screen.queryByRole('button', { name: '급등 이후 이름 수정' })).toBeNull();
  expect(screen.queryByRole('button', { name: '급등 이후 삭제' })).toBeNull();
});

it('double-clicking the saved view name opens inline edit mode and selects the name', async () => {
  renderDrawer('/inventory');

  await userEvent.dblClick(screen.getByText('급등 이후'));
  const input = screen.getByLabelText('저장뷰 이름 수정') as HTMLInputElement;

  expect(input.value).toBe('급등 이후');
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe('급등 이후'.length);
  expect(screen.getByTestId('loc').textContent).toBe('/inventory');
});

it('renames a saved view from double-click edit mode and Enter', async () => {
  renderDrawer('/study?view=a');

  await userEvent.dblClick(screen.getByText('급등 이후'));
  const input = screen.getByLabelText('저장뷰 이름 수정') as HTMLInputElement;
  await userEvent.clear(input);
  await userEvent.type(input, '새 이름{Enter}');

  expect(updateMetadataMutate).toHaveBeenCalledWith(
    { id: 'a', body: { name: '새 이름' } },
    expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
  );
});

it('commits saved view rename on blur', async () => {
  renderDrawer('/study?view=a');

  await userEvent.dblClick(screen.getByText('급등 이후'));
  const input = screen.getByLabelText('저장뷰 이름 수정') as HTMLInputElement;
  await userEvent.clear(input);
  await userEvent.type(input, '블러 저장');
  input.blur();

  await waitFor(() => expect(updateMetadataMutate).toHaveBeenCalledWith(
    { id: 'a', body: { name: '블러 저장' } },
    expect.any(Object),
  ));
});

it('cancels saved view rename on Escape', async () => {
  renderDrawer('/study?view=a');

  await userEvent.dblClick(screen.getByText('급등 이후'));
  const input = screen.getByLabelText('저장뷰 이름 수정') as HTMLInputElement;
  await userEvent.clear(input);
  await userEvent.type(input, '취소할 이름');
  await userEvent.keyboard('{Escape}');

  expect(updateMetadataMutate).not.toHaveBeenCalled();
  expect(screen.getByText('급등 이후')).toBeTruthy();
});

it('starts inline rename without navigating from a non-study route', async () => {
  renderDrawer('/inventory');

  await userEvent.dblClick(screen.getByText('급등 이후'));

  expect(screen.getByLabelText('저장뷰 이름 수정')).toBeTruthy();
  expect(screen.getByTestId('loc').textContent).toBe('/inventory');
});

it('does not rename a saved view when the inline value is empty', async () => {
  renderDrawer('/study?view=a');

  await userEvent.dblClick(screen.getByText('급등 이후'));
  const input = screen.getByLabelText('저장뷰 이름 수정') as HTMLInputElement;
  await userEvent.clear(input);
  await userEvent.keyboard('{Enter}');

  expect(updateMetadataMutate).not.toHaveBeenCalled();
  expect(screen.getByText('급등 이후')).toBeTruthy();
});

it('does not rename a saved view when the inline value is unchanged', async () => {
  renderDrawer('/study?view=a');

  await userEvent.dblClick(screen.getByText('급등 이후'));
  const input = screen.getByLabelText('저장뷰 이름 수정') as HTMLInputElement;
  await userEvent.type(input, '{Enter}');

  expect(updateMetadataMutate).not.toHaveBeenCalled();
  expect(screen.getByText('급등 이후')).toBeTruthy();
});

it('confirms delete before calling remove mutation', async () => {
  renderDrawer('/study?view=a');

  fireEvent.contextMenu(screen.getByRole('button', { name: '급등 이후 저장뷰 열기' }));
  await userEvent.click(screen.getByRole('menuitem', { name: '삭제' }));
  const dialog = screen.getByRole('dialog', { name: '저장뷰 삭제' });
  const confirmButton = within(dialog).getByRole('button', { name: '삭제' });
  expect(document.activeElement).toBe(confirmButton);
  await userEvent.keyboard('{Enter}');

  expect(removeMutate).toHaveBeenCalledWith('a', expect.objectContaining({ onSuccess: expect.any(Function) }));
});

it('navigates away after deleting the active study view', async () => {
  saveSource = {
    origin: 'study',
    viewId: 'a',
    snapshot: snapshotFixture(),
    bundle: rangeBundleFixture(),
    captureViewport: () => null,
  };
  removeMutate.mockImplementation((_id, opts) => opts.onSuccess());
  renderDrawer('/study?view=a');

  fireEvent.contextMenu(screen.getByRole('button', { name: '급등 이후 저장뷰 열기' }));
  await userEvent.click(screen.getByRole('menuitem', { name: '삭제' }));
  const dialog = screen.getByRole('dialog', { name: '저장뷰 삭제' });
  await userEvent.click(within(dialog).getByRole('button', { name: '삭제' }));

  await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/study'));
  expect(screen.queryByRole('dialog', { name: '저장뷰 삭제' })).toBeNull();
});
