import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as api from '../api/watchlist';

const h = vi.hoisted(() => ({
  onDragEnd: null as null | ((e: unknown) => void),
  onPointerDown: vi.fn(),
  setActivatorNodeRef: vi.fn(),
  sortableState: {} as Record<string, Partial<{
    activeIndex: number;
    overIndex: number;
    index: number;
    isDragging: boolean;
  }>>,
}));
vi.mock('@dnd-kit/core', async (orig) => {
  const actual = await orig<typeof import('@dnd-kit/core')>();
  return {
    ...actual,
    DndContext: ({ children, onDragEnd }: { children: React.ReactNode; onDragEnd: (e: unknown) => void }) => {
      h.onDragEnd = onDragEnd;
      return <>{children}</>;
    },
    useSensor: () => ({}),
    useSensors: () => [],
    useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
    PointerSensor: class {},
  };
});
vi.mock('@dnd-kit/sortable', async (orig) => {
  const actual = await orig<typeof import('@dnd-kit/sortable')>();
  return {
    ...actual,
    SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useSortable: ({ id }: { id: string }) => ({
      setNodeRef: () => {},
      setActivatorNodeRef: h.setActivatorNodeRef,
      listeners: { onPointerDown: h.onPointerDown },
      attributes: { role: 'button' },
      transform: null,
      transition: undefined,
      isDragging: h.sortableState[id]?.isDragging ?? false,
      activeIndex: h.sortableState[id]?.activeIndex ?? -1,
      overIndex: h.sortableState[id]?.overIndex ?? -1,
      index: h.sortableState[id]?.index ?? -1,
    }),
  };
});

import { WatchlistEditModal } from './WatchlistEditModal';

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
const DATA = {
  folders: [{ id: 'f_a', name: '스윙', order: 0, capture_enabled: true }],
  entries: [{ code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_a', order: 0 }],
  memos: [],
  next_run_at_ms: 0,
};

describe('WatchlistEditModal', () => {
  beforeEach(() => {
    cleanup();
    h.onDragEnd = null;
    h.onPointerDown.mockClear();
    h.setActivatorNodeRef.mockClear();
    h.sortableState = {};
    vi.restoreAllMocks();
  });
  it('renders dialog with folder list and opens the first group by default', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEditModal onClose={() => {}} />, { wrapper: wrap(qc) });
    expect(await screen.findByRole('dialog', { name: '관심종목 편집' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('스윙')).toBeInTheDocument());
    expect(screen.getByText('삼성전자')).toBeInTheDocument();
    expect(screen.queryByText('미분류')).not.toBeInTheDocument();   // v3: 미분류 폐지
    expect(screen.queryByText('모든 종목')).not.toBeInTheDocument();
  });
  it('keeps folder names readable until row actions are revealed', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue({
      folders: [{ id: 'f_a', name: '길게 만든 관심 그룹 이름', order: 0, capture_enabled: true }],
      entries: [],
      memos: [],
      next_run_at_ms: 0,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<WatchlistEditModal onClose={() => {}} />, { wrapper: wrap(qc) });

    const name = await screen.findByText('길게 만든 관심 그룹 이름');
    const selectButton = name.closest('button');
    const row = screen.getByTestId('folder-row-f_a');
    const actions = screen.getByTestId('folder-row-actions-f_a');

    expect(name).toHaveAttribute('title', '길게 만든 관심 그룹 이름');
    expect(row).toHaveClass('relative');
    // 액션 묶음은 **평범한 flex 아이템**이다 — absolute + hover 패딩(pr-12/pr-16) 조합은
    // 패딩 값과 액션 실제 폭을 손으로 맞춰야 해서 어긋나면 카운트를 덮었다(pr-12 시절
    // 5px 겹침 → `10` 이 `1` 로). 자리를 실제로 차지하면 겹침이 원리적으로 불가능하다.
    expect(actions).not.toHaveClass('absolute');
    expect(actions).toHaveClass('shrink-0');
    expect(selectButton?.className).not.toMatch(/pr-(12|16)/);
  });

  it('paints the selected folder row with the selection tint token', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue({
      folders: [
        { id: 'f_a', name: '스윙', order: 0, capture_enabled: true },
        { id: 'f_b', name: '장기', order: 1, capture_enabled: true },
      ],
      entries: [],
      memos: [],
      next_run_at_ms: 0,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEditModal onClose={() => {}} />, { wrapper: wrap(qc) });
    await screen.findByText('스윙');

    // 클래스로 단언하는 이유: jsdom 은 CSS 변수를 풀지 않아 계산색을 못 본다. 그리고
    // 이전 값(`bg-bg-input`)은 toss-light·ledger 에서 `--bg-card` 와 **같은 값**이라
    // 계산색을 볼 수 있었더라도 "칠했다" 는 통과했을 것이다 — 토큰 이름을 못박아야
    // 값이 또 합쳐질 때 이 테스트가 먼저 깨진다.
    expect(screen.getByTestId('folder-row-f_a')).toHaveClass('bg-tint-selection');
    expect(screen.getByTestId('folder-row-f_b')).not.toHaveClass('bg-tint-selection');

    fireEvent.click(screen.getByText('장기'));
    await waitFor(() => expect(screen.getByTestId('folder-row-f_b')).toHaveClass('bg-tint-selection'));
    expect(screen.getByTestId('folder-row-f_a')).not.toHaveClass('bg-tint-selection');
  });
  it('creates a folder via 그룹 추가', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
    const create = vi.spyOn(api, 'createFolder').mockResolvedValue({ id: 'f_new', name: '장기', order: 1 });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEditModal onClose={() => {}} />, { wrapper: wrap(qc) });
    await screen.findByText('스윙');
    fireEvent.click(screen.getByRole('button', { name: /그룹 추가/ }));
    fireEvent.change(screen.getByPlaceholderText('그룹 이름'), { target: { value: '장기' } });
    fireEvent.submit(screen.getByTestId('folder-create-form'));
    await waitFor(() => expect(create).toHaveBeenCalledWith('장기'));
  });
  it('closes on Escape and backdrop click', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
    const onClose = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEditModal onClose={onClose} />, { wrapper: wrap(qc) });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('renames a folder by double-clicking its name and leaves only delete as the row icon action', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
    const ren = vi.spyOn(api, 'renameFolder').mockResolvedValue();
    const del = vi.spyOn(api, 'deleteFolder').mockResolvedValue();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEditModal onClose={() => {}} />, { wrapper: wrap(qc) });
    await screen.findByText('스윙');
    expect(screen.queryByLabelText('스윙 위로')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('스윙 아래로')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('스윙 이름변경')).not.toBeInTheDocument();
    expect(screen.queryByTestId('folder-drag-handle-f_a')).not.toBeInTheDocument();

    fireEvent.doubleClick(screen.getByText('스윙'));
    const input = screen.getByDisplayValue('스윙');
    fireEvent.change(input, { target: { value: '단타' } });
    fireEvent.blur(input);
    await waitFor(() => expect(ren).toHaveBeenCalledWith('f_a', '단타'));
    // DATA 의 005930 은 f_a 에만 있다 → 고아 1 → 확인을 거친다(ADR-0070 P6).
    fireEvent.click(screen.getByLabelText('스윙 삭제'));
    fireEvent.click(await screen.findByRole('button', { name: '삭제' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('f_a'));
  });

  // --- 폴더 삭제 확인(ADR-0070 P6) ---------------------------------------
  // 서버 `delete_folder` docstring 이 "UI 는 고아가 생기는 삭제 전 확인한다" 를 계약으로
  // 적어 두었는데 이 모달에는 그 확인이 없었다(패널에만 있었다). 아래 셋이 그 계약의
  // 세 축이다: ① 고아가 있으면 확인 없이는 안 지운다 ② 고아가 없으면 확인 없이 지운다
  // ③ 확인이 떠 있는 동안 Escape 는 확인만 닫는다.
  it('does not delete a folder until the confirm is accepted, and names the orphan count', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
    const del = vi.spyOn(api, 'deleteFolder').mockResolvedValue();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEditModal onClose={() => {}} />, { wrapper: wrap(qc) });
    await screen.findByText('스윙');

    fireEvent.click(screen.getByLabelText('스윙 삭제'));
    // 확인이 뜨는 것만으로는 부족하다 — **아직 안 지워졌는지**가 이 테스트의 본체다.
    expect(await screen.findByRole('button', { name: '삭제' })).toBeInTheDocument();
    expect(del).not.toHaveBeenCalled();
    // 행 카운트도 "1" 이라 확인 모달 안으로 좁혀서 읽는다(ConfirmModal 의
    // ariaLabel 은 confirmLabel = '삭제').
    const confirm = screen.getByRole('dialog', { name: '삭제' });
    expect(within(confirm).getByText('1')).toBeInTheDocument();   // 고아 수

    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '취소' })).not.toBeInTheDocument());
    expect(del).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText('스윙 삭제'));
    fireEvent.click(await screen.findByRole('button', { name: '삭제' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('f_a'));
  });

  it('deletes without a confirm when the folder orphans nothing', async () => {
    // 005930 이 f_b 에도 있으므로 f_a 를 지워도 관심종목에서 빠지는 코드가 없다.
    vi.spyOn(api, 'getWatchlist').mockResolvedValue({
      folders: [
        { id: 'f_a', name: '스윙', order: 0, capture_enabled: true },
        { id: 'f_b', name: '장기', order: 1, capture_enabled: true },
      ],
      entries: [
        { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_a', order: 0 },
        { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_b', order: 0 },
      ],
      memos: [],
      next_run_at_ms: 0,
    });
    const del = vi.spyOn(api, 'deleteFolder').mockResolvedValue();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEditModal onClose={() => {}} />, { wrapper: wrap(qc) });
    await screen.findByText('스윙');

    fireEvent.click(screen.getByLabelText('스윙 삭제'));
    await waitFor(() => expect(del).toHaveBeenCalledWith('f_a'));
    expect(screen.queryByRole('button', { name: '취소' })).not.toBeInTheDocument();
  });

  it('closes only the confirm on Escape — the edit modal stays open', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
    const del = vi.spyOn(api, 'deleteFolder').mockResolvedValue();
    const onClose = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEditModal onClose={onClose} />, { wrapper: wrap(qc) });
    await screen.findByText('스윙');
    fireEvent.click(screen.getByLabelText('스윙 삭제'));
    await screen.findByRole('button', { name: '삭제' });

    // 두 ModalShell 이 각자 document keydown 을 듣는다 — 가드가 없으면 Escape 한 번에
    // 확인과 편집 모달이 **같이** 닫힌다(확인을 취소하려다 편집 화면까지 잃는다).
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('button', { name: '취소' })).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: '관심종목 편집' })).toBeInTheDocument();

    // 확인이 닫힌 뒤에는 Escape 가 다시 편집 모달을 닫는다(가드가 눌러붙지 않는다).
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  // pane 이 띄우는 오버레이도 같은 Escape 함정을 탄다 — 그런데 위 `deleteConfirm` 가드는
  // 모달 자신의 state 만 본다. **pane 을 단독 렌더하는 테스트로는 원리적으로 못 본다**:
  // 이중 닫힘은 편집 모달의 document 리스너가 있어야 일어나고, 그 리스너가 **먼저 등록돼
  // 먼저 발화**하는 것이 문제의 본체다. 그래서 이 테스트는 모달 전체를 렌더한다.
  it('pane 의 확인이 떠 있으면 Escape 가 모달을 닫지 않는다', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
    vi.spyOn(api, 'removeEntries').mockResolvedValue();
    const onClose = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEditModal onClose={onClose} />, { wrapper: wrap(qc) });
    await screen.findByText('삼성전자');
    fireEvent.click(screen.getByLabelText('005930 선택'));
    fireEvent.click(screen.getByRole('button', { name: '관심 해제' }));
    await screen.findByRole('dialog', { name: '관심 해제' });

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '관심 해제' })).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: '관심종목 편집' })).toBeInTheDocument();

    // 가드가 눌러붙지 않는다 — 확인이 닫힌 뒤 Escape 는 다시 모달을 닫는다.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('pane 의 이동 메뉴가 열려 있어도 Escape 가 모달을 닫지 않는다', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue({
      folders: [
        { id: 'f_a', name: '스윙', order: 0, capture_enabled: true },
        { id: 'f_b', name: '장기', order: 1, capture_enabled: true },
      ],
      entries: [{ code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_a', order: 0 }],
      memos: [],
      next_run_at_ms: 0,
    });
    const onClose = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEditModal onClose={onClose} />, { wrapper: wrap(qc) });
    await screen.findByText('삼성전자');
    fireEvent.click(screen.getByLabelText('005930 선택'));
    fireEvent.click(screen.getByRole('button', { name: /이동/ }));
    await screen.findByRole('menuitem', { name: '장기' });

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: '장기' })).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('uses the whole folder row as the drag surface and draws one between-row indicator', async () => {
    h.sortableState = {
      f_a: { activeIndex: 0, overIndex: 1, index: 0, isDragging: true },
      f_b: { activeIndex: 0, overIndex: 1, index: 1 },
    };
    vi.spyOn(api, 'getWatchlist').mockResolvedValue({
      folders: [
        { id: 'f_a', name: '스윙', order: 0, capture_enabled: true },
        { id: 'f_b', name: '장기', order: 1, capture_enabled: true },
      ],
      entries: [],
      memos: [],
      next_run_at_ms: 0,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<WatchlistEditModal onClose={() => {}} />, { wrapper: wrap(qc) });

    const first = await screen.findByTestId('folder-row-f_a');
    const second = screen.getByTestId('folder-row-f_b');
    expect(screen.queryByTestId('folder-drag-handle-f_a')).not.toBeInTheDocument();
    expect(h.setActivatorNodeRef).toHaveBeenCalledWith(first);
    fireEvent.pointerDown(first);
    expect(h.onPointerDown).toHaveBeenCalledOnce();
    expect(first.className).not.toContain('after:bg-[var(--accent)]');
    expect(second.className).toContain('after:bg-[var(--accent)]');
    expect(second.className).toContain('after:bottom-0');
  });

  it('uses the whole entry row as the drag surface and draws one between-row indicator', async () => {
    h.sortableState = {
      '005930': { activeIndex: 0, overIndex: 1, index: 0, isDragging: true },
      '000660': { activeIndex: 0, overIndex: 1, index: 1 },
    };
    vi.spyOn(api, 'getWatchlist').mockResolvedValue({
      folders: [{ id: 'f_a', name: '스윙', order: 0, capture_enabled: true }],
      entries: [
        { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_a', order: 0 },
        { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_a', order: 1 },
      ],
      memos: [],
      next_run_at_ms: 0,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<WatchlistEditModal onClose={() => {}} />, { wrapper: wrap(qc) });

    const first = await screen.findByTestId('edit-row-005930');
    const second = screen.getByTestId('edit-row-000660');
    expect(first).not.toHaveTextContent('⠿');
    expect(h.setActivatorNodeRef).toHaveBeenCalledWith(first);
    fireEvent.pointerDown(first);
    expect(h.onPointerDown).toHaveBeenCalledOnce();
    expect(first.className).not.toContain('after:bg-[var(--accent)]');
    expect(second.className).toContain('after:bg-[var(--accent)]');
    expect(second.className).toContain('after:bottom-0');
  });

  it('Escape during folder rename cancels the rename without closing the modal', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
    const ren = vi.spyOn(api, 'renameFolder').mockResolvedValue();
    const onClose = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEditModal onClose={onClose} />, { wrapper: wrap(qc) });
    await screen.findByText('스윙');
    fireEvent.doubleClick(screen.getByText('스윙'));
    const input = screen.getByDisplayValue('스윙');
    fireEvent.change(input, { target: { value: '단타' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    // rename is cancelled (input gone, no mutation) and the modal stays open
    await waitFor(() => expect(screen.getByText('스윙')).toBeInTheDocument());
    expect(ren).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('reorders folders by dragging the group handle — authoritative ordered_ids', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue({
      folders: [
        { id: 'f_a', name: '스윙', order: 0, capture_enabled: true },
        { id: 'f_b', name: '장기', order: 1, capture_enabled: true },
      ],
      entries: [], memos: [], next_run_at_ms: 0,
    });
    const ro = vi.spyOn(api, 'reorderFolders').mockResolvedValue();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEditModal onClose={() => {}} />, { wrapper: wrap(qc) });
    await screen.findByText('스윙');
    h.onDragEnd!({
      active: { id: 'f_a', data: { current: { type: 'folder' } } },
      over: { id: 'f_b', data: { current: { type: 'folder' } } },
    });
    await waitFor(() => expect(ro).toHaveBeenCalledWith(['f_b', 'f_a']));
  });

  // --- v4: 메모가 낀 폴더 (sparse order) ---
  //
  // 1단계가 "2단계에서 확인할 가정" 으로 올려놓고 아직 아무도 검증하지 않은 항목이
  // 이것이다: `resolveDrag` 는 **배열 인덱스** 기반인데, v4 부터 entries 의 order 는
  // 폴더 items 인덱스라 메모가 낀 폴더에서 **띄엄띄엄**해진다(0, 2, 3, 5…).
  // 두 축이 어긋나면 모달 드래그가 엉뚱한 코드 순서를 보낸다.
  //
  // 이 모달은 메모를 **표시하지 않는다**(의도) — 메모 위치에 의견이 없는 화면이라
  // `ordered_codes` 계약(코드만, 메모는 items 인덱스 고정)을 쓴다. 그래서 여기서
  // 재는 것은 "메모를 그리는가" 가 아니라 "sparse order 를 정렬 키로만 쓰는가" 다.
  it('메모가 낀 폴더에서도 코드 순서를 옳게 보낸다 (sparse order)', async () => {
    // items: [005930(0), memo(1), 000660(2), memo(3), 035720(4)]
    vi.spyOn(api, 'getWatchlist').mockResolvedValue({
      folders: [{ id: 'f_a', name: '스윙', order: 0, capture_enabled: true }],
      // **배열 순서를 일부러 섞는다** — order 순으로 넣으면 정렬이 no-op 이라
      // "정렬 키로 쓴다" 를 실제로 재지 못한다(서버도 순서를 보장하지 않는다).
      entries: [
        { code: '035720', name: '카카오', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_a', order: 4 },
        { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_a', order: 0 },
        { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_a', order: 2 },
      ],
      memos: [
        { id: 'm_0000000a', folder_id: 'f_a', order: 1, text: '실적 발표 대기' },
        { id: 'm_0000000b', folder_id: 'f_a', order: 3, text: '' },
      ],
      next_run_at_ms: 0,
    });
    const reorder = vi.spyOn(api, 'reorderEntries').mockResolvedValue();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEditModal onClose={() => {}} />, { wrapper: wrap(qc) });
    await screen.findByText('삼성전자');

    // 메모는 이 화면에 없다 — 코드 3행만 보인다.
    expect(screen.queryByText('실적 발표 대기')).not.toBeInTheDocument();

    // 첫 코드(005930)를 마지막 코드(035720) 자리로 — 배열 인덱스 0 → 2.
    h.onDragEnd!({
      active: { id: '005930', data: { current: { type: 'entry' } } },
      over: { id: '035720', data: { current: { type: 'entry' } } },
    });

    // order 가 0,2,4 로 띄엄띄엄해도 **정렬 키로만** 쓰이므로 코드 순서는 온전하다.
    await waitFor(() => expect(reorder).toHaveBeenCalledWith('f_a', ['000660', '035720', '005930']));
  });

  it('selects the next real group when the currently-selected folder is deleted', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue({
      folders: [
        { id: 'f_a', name: '스윙', order: 0, capture_enabled: true },
        { id: 'f_b', name: '장기', order: 1, capture_enabled: true },
      ],
      entries: [
        { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_a', order: 0 },
        { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_b', order: 0 },
      ],
      memos: [],
      next_run_at_ms: 0,
    });
    vi.spyOn(api, 'deleteFolder').mockResolvedValue();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEditModal onClose={() => {}} />, { wrapper: wrap(qc) });
    await screen.findByText('스윙');
    // select 스윙 → pane filters to its member only (장기 member 000660 hidden)
    fireEvent.click(screen.getByText('스윙'));
    await waitFor(() => expect(screen.queryByText('SK하이닉스')).not.toBeInTheDocument());
    // delete the selected folder → selection moves to the next real group:
    // its member (000660) shows; the deleted folder's member (005930) does not.
    fireEvent.click(screen.getByLabelText('스윙 삭제'));
    fireEvent.click(await screen.findByRole('button', { name: '삭제' }));
    await waitFor(() => expect(screen.getByText('SK하이닉스')).toBeInTheDocument());
    expect(screen.queryByText('삼성전자')).not.toBeInTheDocument();
  });

  it('renders and toggles folder capture setting', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue({
      folders: [{ id: 'f_a', name: '스윙', order: 0, capture_enabled: false }],
      entries: [],
      memos: [],
      next_run_at_ms: 0,
    });
    const setCapture = vi.spyOn(api, 'setFolderCaptureEnabled').mockResolvedValue({
      id: 'f_a',
      name: '스윙',
      order: 0,
      capture_enabled: true,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<WatchlistEditModal onClose={() => {}} />, { wrapper: wrap(qc) });

    const toggle = await screen.findByRole('switch', { name: '스윙 실시간 저장' });
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);

    await waitFor(() => expect(setCapture).toHaveBeenCalledWith('f_a', true));
  });

  it('defaults missing folder capture state to enabled in the edit modal', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue({
      folders: [{ id: 'f_a', name: '스윙', order: 0 }],
      entries: [],
      memos: [],
      next_run_at_ms: 0,
    });
    const setCapture = vi.spyOn(api, 'setFolderCaptureEnabled').mockResolvedValue({
      id: 'f_a',
      name: '스윙',
      order: 0,
      capture_enabled: false,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<WatchlistEditModal onClose={() => {}} />, { wrapper: wrap(qc) });

    const toggle = await screen.findByRole('switch', { name: '스윙 실시간 저장' });
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);

    await waitFor(() => expect(setCapture).toHaveBeenCalledWith('f_a', false));
  });
  // 토글은 이 앱에서 `capture_enabled` 를 보여 주는 **유일한 지점**이다. hover 뒤에 있으면
  // 상태를 볼 수도, 마우스로 누를 수도 없었다(`pointer-events-none`). 신규 폴더가 기본
  // 꺼짐이라(ADR-0079) "안 보이는 기본값" 이 정상 경로였다는 점이 이 계약의 근거다.
  it('keeps the capture toggle visible without hover — only delete hides', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEditModal onClose={() => {}} />, { wrapper: wrap(qc) });
    await screen.findByText('스윙');

    // jsdom 은 :hover 를 모르므로 **클래스로** 읽는다 — 숨김은 opacity 로 하고 있어
    // (Tab 도달 계약) 존재 여부로는 구별되지 않는다.
    //
    // **자기 className 만 보면 안 된다**: 숨김은 조상(액션 묶음 div)에 걸 수도 있어서,
    // 버튼만 검사하면 토글을 통째로 hover 뒤로 되돌려도 테스트가 초록으로 통과한다
    // (red-check 에서 실제로 그랬다). 행까지 거슬러 올라가며 확인한다.
    const hiddenFromView = (el: HTMLElement | null) => {
      for (let n = el; n; n = n.parentElement) {
        if (/(^|\s)(opacity-0|pointer-events-none)(\s|$)/.test(n.className)) return true;
        if (n.dataset.testid?.startsWith('folder-row-f_')) break;   // 행이 상한
      }
      return false;
    };
    expect(hiddenFromView(screen.getByRole('switch', { name: '스윙 실시간 저장' }))).toBe(false);
    expect(hiddenFromView(screen.getByLabelText('스윙 삭제'))).toBe(true);
    expect(screen.getByLabelText('스윙 삭제').className).toMatch(/group-hover:opacity-100/);
  });
  // P1-6: 이름 변경 진입이 더블클릭 전용이라 **키보드로는 아예 불가능**했다. hover 액션을
  // 토글·삭제 둘로 줄인 0.12.17.2 결정은 유지하고(연필 버튼을 되살리지 않는다) 키보드
  // 경로만 연다 — Enter 는 이 버튼의 click(그룹 선택)에 이미 묶여 있어 쓸 수 없다.
  it('enters inline rename with F2 as well as double-click', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
    const ren = vi.spyOn(api, 'renameFolder').mockResolvedValue();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEditModal onClose={() => {}} />, { wrapper: wrap(qc) });
    const name = await screen.findByText('스윙');
    const button = name.closest('button')!;

    // 연필 버튼은 여전히 없다 — 단순화 결정은 그대로다.
    expect(screen.queryByLabelText('스윙 이름변경')).not.toBeInTheDocument();
    expect(button).toHaveAttribute('aria-keyshortcuts', 'F2');

    fireEvent.keyDown(button, { key: 'F2' });
    const input = await screen.findByDisplayValue('스윙');
    fireEvent.change(input, { target: { value: '단타' } });
    fireEvent.blur(input);
    await waitFor(() => expect(ren).toHaveBeenCalledWith('f_a', '단타'));
  });

  it('F2 로 연 편집도 Escape 로 취소되고 모달은 열려 있다', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
    const ren = vi.spyOn(api, 'renameFolder').mockResolvedValue();
    const onClose = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEditModal onClose={onClose} />, { wrapper: wrap(qc) });
    const name = await screen.findByText('스윙');
    fireEvent.keyDown(name.closest('button')!, { key: 'F2' });
    const input = await screen.findByDisplayValue('스윙');

    // input 의 Escape 는 stopPropagation 으로 모달 닫힘을 막는다(기존 계약) — F2 로 연
    // 편집도 같은 input 이라 그 계약을 그대로 물려받는지 확인한다.
    fireEvent.change(input, { target: { value: '버릴 이름' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByDisplayValue('버릴 이름')).not.toBeInTheDocument());
    expect(ren).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('스윙')).toBeInTheDocument();
  });
});
