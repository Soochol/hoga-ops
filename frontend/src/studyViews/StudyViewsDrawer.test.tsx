import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
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
  expect(screen.getByText('차트 화면에서 저장할 수 있습니다.')).toBeTruthy();
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
  expect(screen.getByText('라이브 상단 툴바에서 저장할 수 있습니다.')).toBeTruthy();
});

it('creates a new study save and navigates to the created view', async () => {
  const snapshot = snapshotFixture();
  saveSource = {
    origin: 'study',
    viewId: 'a',
    snapshot,
    bundle: rangeBundleFixture(),
    captureViewport: () => ({ rightEdgeMs: 2_000, barSpan: 2, atLiveEdge: false }),
  };
  createMutate.mockImplementation((_body, opts) => opts.onSuccess({ id: 'created' }));
  renderDrawer('/study?view=a');

  await userEvent.click(screen.getByRole('button', { name: '새 저장본 만들기' }));
  await userEvent.clear(screen.getByLabelText('이름'));
  await userEvent.type(screen.getByLabelText('이름'), ' 새 저장 ');
  await userEvent.type(screen.getByLabelText('메모'), ' 메모 ');
  await userEvent.click(screen.getByRole('button', { name: '저장' }));

  expect(createMutate).toHaveBeenCalledTimes(1);
  const body = createMutate.mock.calls[0][0];
  expect(body.name).toBe('새 저장');
  expect(body.memo).toBe('메모');
  expect(body.provenance.saved_from_route).toBe('/study');
  await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/study?view=created'));
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

it('renames a saved view on double-click and Enter', async () => {
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

it('confirms delete before calling remove mutation', async () => {
  renderDrawer('/study?view=a');

  await userEvent.click(screen.getByRole('button', { name: '급등 이후 삭제' }));
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

  await userEvent.click(screen.getByRole('button', { name: '급등 이후 삭제' }));
  const dialog = screen.getByRole('dialog', { name: '저장뷰 삭제' });
  await userEvent.click(within(dialog).getByRole('button', { name: '삭제' }));

  await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/study'));
  expect(screen.queryByRole('dialog', { name: '저장뷰 삭제' })).toBeNull();
});
