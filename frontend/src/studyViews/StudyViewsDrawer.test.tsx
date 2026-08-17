import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudyViewReference } from '../api/studyViews';
import { useEntryDragStore } from '../state/entryDrag';
import { useStudyActiveViewStore } from '../state/studyActiveView';
import { useStudyLastMinuteTimeframeStore } from '../state/studyLastMinuteTimeframe';
import { StudyViewsDrawer, filterStudyViews, formatStudyViewMeta } from './StudyViewsDrawer';

type DndHandlers = {
  onDragStart: null | ((event: unknown) => void);
  onDragMove: null | ((event: unknown) => void);
  onDragEnd: null | ((event: unknown) => void);
  onDragCancel: null | (() => void);
};

const dnd = vi.hoisted<DndHandlers>(() => ({
  onDragStart: null,
  onDragMove: null,
  onDragEnd: null,
  onDragCancel: null,
}));

vi.mock('@dnd-kit/core', async (orig) => {
  const actual = await orig<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: ({
      children,
      onDragStart,
      onDragMove,
      onDragEnd,
      onDragCancel,
    }: {
      children: React.ReactNode;
      onDragStart?: (event: unknown) => void;
      onDragMove?: (event: unknown) => void;
      onDragEnd?: (event: unknown) => void;
      onDragCancel?: () => void;
    }) => {
      dnd.onDragStart = onDragStart ?? null;
      dnd.onDragMove = onDragMove ?? null;
      dnd.onDragEnd = onDragEnd ?? null;
      dnd.onDragCancel = onDragCancel ?? null;
      return <>{children}</>;
    },
    useSensor: () => ({}),
    useSensors: () => [],
    PointerSensor: class {},
  };
});

vi.mock('@dnd-kit/sortable', async (orig) => {
  const actual = await orig<typeof import('@dnd-kit/sortable')>();
  return {
    ...actual,
    SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useSortable: () => ({
      setNodeRef: () => {},
      listeners: {},
      transform: null,
      transition: undefined,
      isDragging: false,
    }),
  };
});

const createMutate = vi.fn();
const updateMutate = vi.fn();
const updateMetadataMutate = vi.fn();
const removeMutate = vi.fn();
let mockedSaves: StudyViewReference[] = [];

const saves: StudyViewReference[] = [
  {
    schema_version: 2,
    id: 'a',
    name: '급등 이후',
    code: '005930',
    label: '삼성전자',
    timeframe: '5m',
    memo: 'memo one',
    tags: [],
    range: { from_date: '20260616', to_date: '20260616', from_ms: 1_000, to_ms: 2_000 },
    viewport: { right_edge_ms: 2_000, bar_span: 200, at_live_edge: false },
    created_at_ms: 1,
    updated_at_ms: 1,
  },
  {
    schema_version: 2,
    id: 'b',
    name: '눌림',
    code: '000660',
    label: 'SK하이닉스',
    timeframe: 'D',
    memo: 'space memo',
    tags: [],
    range: { from_date: '20260616', to_date: '20260616', from_ms: 1_000, to_ms: 2_000 },
    viewport: { right_edge_ms: 2_000, bar_span: 200, at_live_edge: false },
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

function groupHeaderLabels(): string[] {
  return screen
    .getAllByRole('button')
    .map((button) => button.getAttribute('aria-label'))
    .filter((label): label is string => !!label && /\d{6}/.test(label) && (label.endsWith('접기') || label.endsWith('펼치기')));
}

beforeEach(() => {
  window.localStorage.clear();
  createMutate.mockReset();
  updateMutate.mockReset();
  updateMetadataMutate.mockReset();
  removeMutate.mockReset();
  dnd.onDragStart = null;
  dnd.onDragMove = null;
  dnd.onDragEnd = null;
  dnd.onDragCancel = null;
  mockedSaves = saves;
  useStudyLastMinuteTimeframeStore.setState({ lastMinuteTimeframe: '3m' });
  useStudyActiveViewStore.setState({ active: null });
  (useEntryDragStore.setState as unknown as (state: Record<string, unknown>) => void)({
    draggingCode: null,
    overChart: false,
    overStudy: false,
    hitTestChart: null,
    hitTestStudy: null,
    targets: {},
  });
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
  expect(screen.getByRole('complementary', { name: '저장뷰' })).toHaveClass('bg-bg');
  // 경계선 없는 표면(2026-07-22 C안) + 페이지 필드와 동일 톤(2026-07-29 배경 통일 완결).
  expect(screen.getByRole('complementary', { name: '저장뷰' })).not.toHaveClass('border-l');
  expect(screen.getByText('급등 이후')).toBeTruthy();
  await userEvent.type(screen.getByLabelText('저장뷰 검색'), '없음');
  expect(screen.getByText('검색 결과가 없습니다')).toBeTruthy();
  expect(screen.queryByText('차트 화면에서 저장할 수 있습니다')).toBeNull();
});

it('clears the saved-view search with the inline clear button', async () => {
  renderDrawer('/inventory');
  const search = screen.getByLabelText('저장뷰 검색') as HTMLInputElement;

  expect(screen.queryByRole('button', { name: '검색어 지우기' })).toBeNull();

  await userEvent.type(search, '없음');
  expect(search.value).toBe('없음');
  expect(screen.getByText('검색 결과가 없습니다')).toBeTruthy();

  await userEvent.click(screen.getByRole('button', { name: '검색어 지우기' }));

  expect(search.value).toBe('');
  expect(screen.queryByRole('button', { name: '검색어 지우기' })).toBeNull();
  expect(screen.getByText('급등 이후')).toBeTruthy();
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

// 스토어가 URL 을 이긴다 — 이 드로어는 우측 레일의 **전역** 컴포넌트라 `/live` 등에서는
// URL 에 `?view=` 가 아예 없고, 스토어를 안 읽으면 하이라이트가 그 라우트에서 사라진다.
it('highlights the saved-view row for the active study view', () => {
  useStudyActiveViewStore.setState({
    active: { viewId: 'b', code: '000660', label: 'SK하이닉스', name: '눌림' },
  });
  renderDrawer('/study?view=a');

  const activeRow = screen.getByRole('button', { name: '눌림 저장뷰 열기' });
  expect(activeRow).toHaveAttribute('aria-current', 'true');
  // 선택 표식은 배경 틴트(--tint-selection)만 — 좌측 accent 바는 관심·순위·스크리너와의
  // 행 통일(2026-07-23)에서 의도적으로 제거됐다. 다시 넣지 말 것.
  expect(activeRow).toHaveStyle({ background: 'var(--tint-selection)' });
  expect(screen.getByRole('button', { name: '급등 이후 저장뷰 열기' })).not.toHaveAttribute('aria-current');
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

  await userEvent.type(screen.getByLabelText('저장뷰 검색'), '삼성');

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

  await userEvent.type(screen.getByLabelText('저장뷰 검색'), '005 930');

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

  await userEvent.type(screen.getByLabelText('저장뷰 검색'), 'close rebound');

  expect(screen.getByRole('button', { name: '삼성전자 005930 접기' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: '급등 이후 저장뷰 열기' })).toBeNull();
  expect(screen.getByRole('button', { name: '종가 반등 저장뷰 열기' })).toBeTruthy();
});

it('respects collapsed groups during search', async () => {
  renderDrawer('/inventory');

  await userEvent.click(screen.getByRole('button', { name: '삼성전자 005930 접기' }));
  await userEvent.type(screen.getByLabelText('저장뷰 검색'), '삼성');

  expect(screen.getByRole('button', { name: '삼성전자 005930 펼치기' })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('button', { name: '급등 이후 저장뷰 열기' })).toBeNull();
});

it('toggles all visible stock groups with one toolbar button', async () => {
  renderDrawer('/inventory');

  expect(screen.getByRole('button', { name: '전체 접기' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: '전체 펼치기' })).toBeNull();

  await userEvent.click(screen.getByRole('button', { name: '전체 접기' }));

  expect(screen.getByRole('button', { name: '삼성전자 005930 펼치기' })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.getByRole('button', { name: 'SK하이닉스 000660 펼치기' })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('button', { name: '급등 이후 저장뷰 열기' })).toBeNull();
  expect(screen.queryByRole('button', { name: '눌림 저장뷰 열기' })).toBeNull();
  expect(screen.queryByRole('button', { name: '전체 접기' })).toBeNull();
  expect(screen.getByRole('button', { name: '전체 펼치기' })).toBeTruthy();

  await userEvent.click(screen.getByRole('button', { name: '전체 펼치기' }));

  expect(screen.getByRole('button', { name: '삼성전자 005930 접기' })).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('button', { name: 'SK하이닉스 000660 접기' })).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('button', { name: '급등 이후 저장뷰 열기' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '눌림 저장뷰 열기' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '전체 접기' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: '전체 펼치기' })).toBeNull();
});

it('bulk controls affect filtered visible groups without changing hidden groups', async () => {
  renderDrawer('/inventory');

  await userEvent.type(screen.getByLabelText('저장뷰 검색'), 'SK');
  await userEvent.click(screen.getByRole('button', { name: '전체 접기' }));
  await userEvent.clear(screen.getByLabelText('저장뷰 검색'));

  expect(screen.getByRole('button', { name: '삼성전자 005930 접기' })).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('button', { name: '급등 이후 저장뷰 열기' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'SK하이닉스 000660 펼치기' })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('button', { name: '눌림 저장뷰 열기' })).toBeNull();
});

it('moves the live save action out of the drawer', () => {
  renderDrawer('/live');

  expect(screen.queryByRole('button', { name: '현재 뷰 저장' })).toBeNull();
  expect(screen.queryByText('라이브 상단 툴바에서 저장할 수 있습니다')).toBeNull();
});

it('does not show the secondary new-save action in the drawer body', () => {
  renderDrawer('/study?view=a');

  expect(screen.queryByRole('button', { name: '새 저장본 만들기' })).toBeNull();
});

it('does not show the load-before-save hint in the study drawer', () => {
  renderDrawer('/study');

  expect(screen.queryByText('학습뷰를 불러온 뒤 저장할 수 있습니다')).toBeNull();
});

it('does not show overwrite action in the study saved-view drawer', () => {
  renderDrawer('/study?view=a');

  expect(screen.queryByRole('button', { name: '덮어쓰기' })).toBeNull();
  expect(screen.queryByRole('button', { name: '현재 뷰 저장' })).toBeNull();
  expect(screen.queryByRole('dialog', { name: '저장뷰 덮어쓰기' })).toBeNull();
  expect(updateMutate).not.toHaveBeenCalled();
});

it('does not expose overwrite when the current study save is missing from the drawer list', () => {
  mockedSaves = [saves[1]];
  renderDrawer('/study?view=missing-current');

  expect(screen.queryByRole('button', { name: '덮어쓰기' })).toBeNull();
  expect(screen.queryByRole('dialog', { name: '저장뷰 덮어쓰기' })).toBeNull();
  expect(updateMutate).not.toHaveBeenCalled();
  expect(createMutate).not.toHaveBeenCalled();
});

it('clicking the saved view title navigates to the study route', async () => {
  renderDrawer('/inventory');

  await userEvent.click(screen.getByRole('button', { name: '급등 이후 저장뷰 열기' }));

  await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/study?view=a'));
});

it('normal row click replaces the active study view instead of opening only the route', async () => {
  useStudyActiveViewStore.getState().openSave(saves[1]);
  renderDrawer('/study?view=b');

  await userEvent.click(screen.getByRole('button', { name: '급등 이후 저장뷰 열기' }));

  await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/study?view=a'));
  // 제자리 교체 — 뷰가 쌓이지 않는다(ADR-0148).
  expect(useStudyActiveViewStore.getState().active).toEqual({
    viewId: 'a',
    code: '005930',
    label: '삼성전자',
    name: '급등 이후',
  });
});

// 스토어는 **봉을 담지 않는다**(ADR-0148) — 봉의 소유자는 차트 창이다(#1326).
// 종전엔 탭이 저장 봉을 들고 있어서 "서랍이 딴 값을 끼워 넣지 않는가" 를 여기서 쟀다.
// 이제는 담을 자리 자체가 없다는 것이 계약이고, 그것을 그대로 잰다.
it('저장뷰를 열어도 스토어에 봉이 들어가지 않는다 — 봉은 창이 소유한다', async () => {
  useStudyLastMinuteTimeframeStore.setState({ lastMinuteTimeframe: '15m' });
  mockedSaves = [{ ...saves[0], timeframe: '10m' }];
  renderDrawer('/inventory');

  await userEvent.click(screen.getByRole('button', { name: '급등 이후 저장뷰 열기' }));

  await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/study?view=a'));
  expect(useStudyActiveViewStore.getState().active).not.toHaveProperty('timeframe');
});


it('clicking the saved view name text navigates to the study route', async () => {
  renderDrawer('/inventory');

  await userEvent.click(screen.getByText('급등 이후'));

  await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/study?view=a'));
});

// ADR-0148 §「Ctrl+클릭은 일반 클릭과 동일」 — 탭이 없으면 "새 탭으로" 가 무의미하다
// (ADR-0113 §3 의 `disposition` 제거와 동형). 계산만 하고 버려지는 배선을 남기지 않는다.
it('ctrl-clicking a saved view row behaves exactly like a normal click', async () => {
  useStudyActiveViewStore.getState().openSave(saves[1]);
  renderDrawer('/inventory');

  fireEvent.click(screen.getByRole('button', { name: '급등 이후 저장뷰 열기' }), { ctrlKey: true });

  await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/study?view=a'));
  expect(useStudyActiveViewStore.getState().active).toMatchObject({ viewId: 'a', name: '급등 이후' });
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

it('defers deletion behind an undo grace period from the row context menu', () => {
  vi.useFakeTimers();
  try {
    renderDrawer('/study?view=a');

    fireEvent.contextMenu(screen.getByRole('button', { name: '급등 이후 저장뷰 열기' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '삭제' }));

    // 행은 즉시 사라지고 토스트가 뜨지만, 유예가 끝나기 전엔 DELETE 가 나가지 않는다.
    expect(screen.queryByRole('button', { name: '급등 이후 저장뷰 열기' })).toBeNull();
    expect(screen.getByText('‘급등 이후’ 삭제됨')).toBeTruthy();
    expect(removeMutate).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(5000); });

    expect(removeMutate).toHaveBeenCalledWith('a', expect.objectContaining({ onSuccess: expect.any(Function) }));
    expect(screen.queryByText('‘급등 이후’ 삭제됨')).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it('restores the row and skips the DELETE when undo is clicked within the grace period', () => {
  vi.useFakeTimers();
  try {
    renderDrawer('/inventory');

    fireEvent.contextMenu(screen.getByRole('button', { name: '급등 이후 저장뷰 열기' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '삭제' }));
    expect(screen.queryByRole('button', { name: '급등 이후 저장뷰 열기' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '실행 취소' }));

    expect(screen.getByRole('button', { name: '급등 이후 저장뷰 열기' })).toBeTruthy();
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(removeMutate).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it('flushes the previous pending delete when a second delete is requested', () => {
  vi.useFakeTimers();
  try {
    renderDrawer('/inventory');

    fireEvent.contextMenu(screen.getByRole('button', { name: '급등 이후 저장뷰 열기' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '삭제' }));
    expect(removeMutate).not.toHaveBeenCalled();

    fireEvent.contextMenu(screen.getByRole('button', { name: '눌림 저장뷰 열기' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '삭제' }));

    // 두 번째 삭제 요청이 첫 번째를 그 자리에서 확정한다(단일 실행취소 슬롯).
    expect(removeMutate).toHaveBeenCalledTimes(1);
    expect(removeMutate).toHaveBeenCalledWith('a', expect.any(Object));

    act(() => { vi.advanceTimersByTime(5000); });
    expect(removeMutate).toHaveBeenCalledWith('b', expect.any(Object));
  } finally {
    vi.useRealTimers();
  }
});

it('navigates away after the delete grace period for the active study view', () => {
  vi.useFakeTimers();
  try {
    removeMutate.mockImplementation((_id, opts) => opts.onSuccess());
    renderDrawer('/study?view=a');

    fireEvent.contextMenu(screen.getByRole('button', { name: '급등 이후 저장뷰 열기' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '삭제' }));
    act(() => { vi.advanceTimersByTime(5000); });

    expect(screen.getByTestId('loc').textContent).toBe('/study');
  } finally {
    vi.useRealTimers();
  }
});

// 남의 뷰를 지웠을 뿐이니 화면이 흔들리면 안 된다.
it('비활성 저장뷰를 지워도 활성 뷰와 라우트는 그대로다', () => {
  vi.useFakeTimers();
  try {
    useStudyActiveViewStore.getState().openSave(saves[1]);
    removeMutate.mockImplementation((_id, opts) => opts.onSuccess());
    renderDrawer('/study?view=b');

    fireEvent.contextMenu(screen.getByRole('button', { name: '급등 이후 저장뷰 열기' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '삭제' }));
    act(() => { vi.advanceTimersByTime(5000); });

    expect(useStudyActiveViewStore.getState().active).toMatchObject({ viewId: 'b' });
    expect(screen.getByTestId('loc').textContent).toBe('/study?view=b');
  } finally {
    vi.useRealTimers();
  }
});

it('opens the full row menu from the hover ⋯ button without navigating', async () => {
  renderDrawer('/inventory');

  await userEvent.click(screen.getByRole('button', { name: '급등 이후 행 메뉴' }));

  const menu = screen.getByRole('menu', { name: '급등 이후 저장뷰 메뉴' });
  expect(within(menu).getByRole('menuitem', { name: '열기' })).toBeTruthy();
  // 「새 탭에서 열기」는 ADR-0148 로 사라졌다.
  expect(within(menu).queryByRole('menuitem', { name: '새 탭에서 열기' })).toBeNull();
  expect(within(menu).getByRole('menuitem', { name: '이름 변경' })).toBeTruthy();
  expect(within(menu).getByRole('menuitem', { name: '메모 편집' })).toBeTruthy();
  expect(within(menu).getByRole('menuitem', { name: '삭제' })).toBeTruthy();
  expect(screen.getByTestId('loc').textContent).toBe('/inventory');
});

it('opens the saved view from the row menu 열기 item', async () => {
  renderDrawer('/inventory');

  await userEvent.click(screen.getByRole('button', { name: '급등 이후 행 메뉴' }));
  await userEvent.click(screen.getByRole('menuitem', { name: '열기' }));

  await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/study?view=a'));
});

it('starts inline rename from the row menu', async () => {
  renderDrawer('/inventory');

  await userEvent.click(screen.getByRole('button', { name: '급등 이후 행 메뉴' }));
  await userEvent.click(screen.getByRole('menuitem', { name: '이름 변경' }));

  expect((screen.getByLabelText('저장뷰 이름 수정') as HTMLInputElement).value).toBe('급등 이후');
});

it('renders a one-line memo preview under the meta line', () => {
  mockedSaves = [{ ...saves[0], memo: '첫 줄 메모\n둘째 줄' }, saves[1]];
  renderDrawer('/inventory');

  expect(screen.getByText('첫 줄 메모')).toBeTruthy();
  expect(screen.queryByText(/둘째 줄/)).toBeNull();
});

it('edits the memo inline from the row menu and commits with Enter', async () => {
  renderDrawer('/inventory');

  await userEvent.click(screen.getByRole('button', { name: '급등 이후 행 메뉴' }));
  await userEvent.click(screen.getByRole('menuitem', { name: '메모 편집' }));

  const textarea = screen.getByLabelText('저장뷰 메모 수정') as HTMLTextAreaElement;
  expect(textarea.value).toBe('memo one');
  await userEvent.clear(textarea);
  await userEvent.type(textarea, '새 메모{Enter}');

  expect(updateMetadataMutate).toHaveBeenCalledWith(
    { id: 'a', body: { memo: '새 메모' } },
    expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
  );
});

it('cancels memo edit on Escape without saving', async () => {
  renderDrawer('/inventory');

  await userEvent.click(screen.getByRole('button', { name: '급등 이후 행 메뉴' }));
  await userEvent.click(screen.getByRole('menuitem', { name: '메모 편집' }));
  const textarea = screen.getByLabelText('저장뷰 메모 수정') as HTMLTextAreaElement;
  await userEvent.clear(textarea);
  await userEvent.type(textarea, '버릴 메모');
  await userEvent.keyboard('{Escape}');

  expect(updateMetadataMutate).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('저장뷰 메모 수정')).toBeNull();
});

// 그룹 헤더 Ctrl+클릭 = 그 종목의 최신 저장뷰를 새 탭으로, 도 ADR-0148 로 사라졌다.
// 헤더 클릭은 이제 접기/펼치기 하나뿐이다.
it('ctrl-clicking a stock group header just toggles the group', async () => {
  mockedSaves = [
    ...saves,
    { ...saves[0], id: 'c', name: '종가 반등', memo: 'close rebound', updated_at_ms: 2, created_at_ms: 2 },
  ];
  useStudyActiveViewStore.getState().openSave(saves[1]);
  renderDrawer('/inventory');

  fireEvent.click(screen.getByRole('button', { name: '삼성전자 005930 접기' }), { ctrlKey: true });

  await waitFor(() => (
    expect(screen.getByRole('button', { name: '삼성전자 005930 펼치기' })).toBeTruthy()
  ));
  // 라우트도 활성 뷰도 그대로다.
  expect(screen.getByTestId('loc').textContent).toBe('/inventory');
  expect(useStudyActiveViewStore.getState().active).toMatchObject({ viewId: 'b' });
});

it('updates study hover state during stock-group drag', async () => {
  const hitTest = (clientX: number) => clientX < 800;
  useEntryDragStore.getState().registerStudyTarget(hitTest);

  try {
    renderDrawer('/inventory');
    await waitFor(() => expect(screen.getByRole('button', { name: '삼성전자 005930 접기' })).toBeInTheDocument());

    dnd.onDragStart?.({
      active: { id: 'study-view-group:005930', data: { current: { type: 'group', code: '005930' } } },
    });
    expect(useEntryDragStore.getState().draggingCode).toBe('005930');

    dnd.onDragMove?.({
      active: { id: 'study-view-group:005930', data: { current: { type: 'group', code: '005930' } } },
      activatorEvent: { clientX: 900, clientY: 300 } as MouseEvent,
      delta: { x: -500, y: 0 },
    });
    expect(useEntryDragStore.getState().overStudy).toBe(true);

    dnd.onDragCancel?.();
    expect(useEntryDragStore.getState().draggingCode).toBeNull();
    expect(useEntryDragStore.getState().overStudy).toBe(false);
  } finally {
    useEntryDragStore.getState().clearStudyTarget(hitTest);
  }
});

it('dragging a stock group over the study target opens its newest save without reordering groups', async () => {
  mockedSaves = [
    ...saves,
    { ...saves[0], id: 'c', name: '종가 반등', memo: 'close rebound', updated_at_ms: 2, created_at_ms: 2 },
  ];
  useStudyActiveViewStore.getState().openSave(saves[1]);
  const hitTest = (clientX: number) => clientX < 800;
  useEntryDragStore.getState().registerStudyTarget(hitTest);

  try {
    renderDrawer('/inventory');
    expect(groupHeaderLabels()).toEqual(['삼성전자 005930 접기', 'SK하이닉스 000660 접기']);

    dnd.onDragEnd?.({
      active: { id: 'study-view-group:005930', data: { current: { type: 'group' } } },
      over: { id: 'study-view-group:000660', data: { current: { type: 'group' } } },
      activatorEvent: { clientX: 900, clientY: 300 } as MouseEvent,
      delta: { x: -500, y: 0 },
    });

    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/study?view=c'));
    // 제자리 교체 — 드롭이 뷰를 쌓지 않는다.
    expect(useStudyActiveViewStore.getState().active).toMatchObject({ viewId: 'c', name: '종가 반등' });
    expect(groupHeaderLabels()).toEqual(['삼성전자 005930 접기', 'SK하이닉스 000660 접기']);
  } finally {
    useEntryDragStore.getState().clearStudyTarget(hitTest);
  }
});

it('dragging a stock group outside the study target still reorders groups', async () => {
  const hitTest = (clientX: number) => clientX < 800;
  useEntryDragStore.getState().registerStudyTarget(hitTest);

  try {
    renderDrawer('/inventory');
    expect(groupHeaderLabels()).toEqual(['삼성전자 005930 접기', 'SK하이닉스 000660 접기']);

    dnd.onDragEnd?.({
      active: { id: 'study-view-group:005930', data: { current: { type: 'group' } } },
      over: { id: 'study-view-group:000660', data: { current: { type: 'group' } } },
      activatorEvent: { clientX: 900, clientY: 300 } as MouseEvent,
      delta: { x: 0, y: 0 },
    });

    await waitFor(() => expect(groupHeaderLabels()).toEqual(['SK하이닉스 000660 접기', '삼성전자 005930 접기']));
    expect(screen.getByTestId('loc').textContent).toBe('/inventory');
    expect(useStudyActiveViewStore.getState().active).toBeNull();
  } finally {
    useEntryDragStore.getState().clearStudyTarget(hitTest);
  }
});

describe('formatStudyViewMeta', () => {
  it('shows timeframe · single date (from==to) with the year', () => {
    expect(
      formatStudyViewMeta({ timeframe: '1m', range: { from_date: '20260708', to_date: '20260708' } }),
    ).toBe('1m · 2026-07-08');
  });

  // 같은 해 안의 범위는 `to` 쪽 연도를 접는다 — 메타행이 truncate 라 아낀 폭이
  // 그대로 `to` 날짜의 생존으로 돌아온다.
  it('shows a date range when from != to, folding the repeated year', () => {
    expect(
      formatStudyViewMeta({ timeframe: 'D', range: { from_date: '20260701', to_date: '20260708' } }),
    ).toBe('D · 2026-07-01~07-08');
  });

  it('keeps both years when the range crosses a year boundary', () => {
    expect(
      formatStudyViewMeta({ timeframe: 'D', range: { from_date: '20251228', to_date: '20260105' } }),
    ).toBe('D · 2025-12-28~2026-01-05');
  });
});
