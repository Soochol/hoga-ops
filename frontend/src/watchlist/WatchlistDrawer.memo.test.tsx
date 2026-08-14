import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { WatchlistDrawer } from './WatchlistDrawer';
import { useLivePageStore } from '../state/livePage';
import * as watchlistApi from '../api/watchlist';
import * as client from '../api/client';

/** 관심종목 패널의 메모("빈칸") 행 — 렌더·추가·편집·삭제와 게이트들. */

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/inventory']}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

type Entry = watchlistApi.WatchlistEntry;

const FOLDERS = [{ id: 'f_0000000a', name: '스윙', order: 0, capture_enabled: true }];
// items: [005930(0), memo(1), 000660(2)] — 메모가 종목 **사이**에 있다.
const ENTRIES: Entry[] = [
  { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_0000000a', order: 0 },
  { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_0000000a', order: 2 },
];
const MEMOS: watchlistApi.WatchlistMemo[] = [{ id: 'm_0000000a', folder_id: 'f_0000000a', order: 1, text: '실적 발표 대기' }];
const DATA = { folders: FOLDERS, entries: ENTRIES, memos: MEMOS, next_run_at_ms: 0 };

function renderPanel(data = DATA) {
  vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue(data);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<WatchlistDrawer />, { wrapper: wrap(qc) });
  return qc;
}

describe('WatchlistDrawer — 메모(빈칸) 행', () => {
  beforeEach(() => {
    cleanup();
    window.localStorage.clear();
    useLivePageStore.setState({ activeInstrument: null, activeCode: null, candleTimeframe: '1m' });
    vi.restoreAllMocks();
    vi.spyOn(client, 'apiCall').mockResolvedValue({ phase: 'open', quotes: [] });
  });

  it('메모가 종목 사이 제자리에 그려진다', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByTestId('watchlist-memo-m_0000000a')).toBeInTheDocument());
    expect(screen.getByText('실적 발표 대기')).toBeInTheDocument();
    // DOM 순서로 위치를 확인한다 — order 축 병합이 실제로 먹었는지는 여기서만 보인다.
    // `li` 로 한정해 행 안의 버튼(…-delete)이 prefix 매칭에 딸려오지 않게 한다.
    const rows = Array.from(
      document.querySelectorAll('li[data-testid^="watchlist-row-"], li[data-testid^="watchlist-memo-"]'),
    ).map((el) => el.getAttribute('data-testid'));
    expect(rows).toEqual([
      'watchlist-row-005930',
      'watchlist-memo-m_0000000a',
      'watchlist-row-000660',
    ]);
  });

  it('빈 메모는 텍스트 없이 행 높이만 차지한다 — 그게 "빈칸"이다', async () => {
    renderPanel({ ...DATA, memos: [{ ...MEMOS[0], text: '' }] });
    const row = await screen.findByTestId('watchlist-memo-m_0000000a');
    expect(row).toHaveTextContent('');
    expect(row.className).toContain('min-h-list-row');
  });

  it('메모 행은 차트 이동용 행이 아니다 — 키보드 ↑↓ 네비게이션이 건너뛴다', async () => {
    renderPanel();
    const row = await screen.findByTestId('watchlist-memo-m_0000000a');
    // QuoteRow 의 ↑↓ 는 [data-quote-row] 로 행을 모은다. 그 속성이 없으면 자동 제외.
    expect(row).not.toHaveAttribute('data-quote-row');
    expect(row).not.toHaveAttribute('role', 'button');
  });

  // --- 키보드 접근성 (3단계) ---

  it('키보드만으로 편집할 수 있다 — 편집 진입이 형제 버튼이라 Tab 으로 닿는다', async () => {
    const patch = vi.spyOn(watchlistApi, 'updateMemo').mockResolvedValue(MEMOS[0]);
    renderPanel();
    const editBtn = await screen.findByTestId('watchlist-memo-m_0000000a-edit');
    // 행(li)이 아니라 버튼이 포커스 대상이다 — li 에 tabIndex 를 주면 삭제 버튼과
    // 중첩 인터랙티브가 되어 이 경로가 막힌다.
    editBtn.focus();
    expect(document.activeElement).toBe(editBtn);
    fireEvent.keyDown(editBtn, { key: 'Enter' });
    fireEvent.click(editBtn);   // Enter 는 button 기본 동작으로 click 을 낳는다
    const input = screen.getByTestId('watchlist-memo-m_0000000a-input');
    fireEvent.change(input, { target: { value: '키보드로 입력' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(patch).toHaveBeenCalledWith('m_0000000a', '키보드로 입력'));
  });

  it('빈칸도 접근성 이름을 갖는다 — 텍스트가 없으면 AT 가 "버튼"으로만 읽는다', async () => {
    renderPanel({ ...DATA, memos: [{ ...MEMOS[0], text: '' }] });
    await screen.findByTestId('watchlist-memo-m_0000000a');
    expect(screen.getByLabelText('빈칸 — 메모 입력')).toBeInTheDocument();
    expect(screen.getByLabelText('빈칸 삭제')).toBeInTheDocument();
  });

  it('메모가 있으면 라벨이 상태와 액션을 함께 말한다', async () => {
    renderPanel();
    await screen.findByTestId('watchlist-memo-m_0000000a');
    expect(screen.getByLabelText('메모 편집: 실적 발표 대기')).toBeInTheDocument();
    expect(screen.getByLabelText('메모 삭제: 실적 발표 대기')).toBeInTheDocument();
  });

  it('긴 메모는 truncate 되지만 title 로 전문이 남는다', async () => {
    const long = '가'.repeat(60);
    renderPanel({ ...DATA, memos: [{ ...MEMOS[0], text: long }] });
    const btn = await screen.findByTestId('watchlist-memo-m_0000000a-edit');
    expect(btn).toHaveAttribute('title', long);
    expect(btn.querySelector('.truncate')).not.toBeNull();
  });

  it('빈 줄도 클릭 타깃을 갖는다 — 텍스트가 없으면 버튼 높이가 0 이 된다', async () => {
    // `self-stretch` 가 없으면 빈 버튼은 높이 0 이라 마우스로도 키보드로도 닿을 수
    // 없다(Playwright 가 hidden 으로 판정해 잡아낸 회귀). jsdom 은 레이아웃을 계산하지
    // 않아 클래스로만 확인 가능하다 — 실제 판정은 e2e 가 한다.
    const patch = vi.spyOn(watchlistApi, 'updateMemo').mockResolvedValue(MEMOS[0]);
    renderPanel({ ...DATA, memos: [{ ...MEMOS[0], text: '' }] });
    const btn = await screen.findByTestId('watchlist-memo-m_0000000a-edit');
    expect(btn.className).toContain('self-stretch');
    fireEvent.click(btn);
    const input = screen.getByTestId('watchlist-memo-m_0000000a-input');
    fireEvent.change(input, { target: { value: '빈 줄에 쓴 메모' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(patch).toHaveBeenCalledWith('m_0000000a', '빈 줄에 쓴 메모'));
  });

  it('편집 버튼 클릭이 행의 드래그 listeners 에 먹히지 않는다', async () => {
    // listeners 달린 li 안의 버튼 클릭은 이 패널에서 새 조합이다(RowTrailing ⋯ 가
    // 같은 구조로 돌지만 메모 행은 별도 컴포넌트다). dnd PointerSensor 가
    // pointerdown 을 가로채 클릭이 죽으면 편집 진입이 통째로 막힌다.
    renderPanel();
    const btn = await screen.findByTestId('watchlist-memo-m_0000000a-edit');
    fireEvent.pointerDown(btn);            // dnd 가 먼저 보는 이벤트
    fireEvent.click(btn);
    expect(screen.getByTestId('watchlist-memo-m_0000000a-input')).toBeInTheDocument();
  });

  it('클릭하면 인라인 편집이 열리고 Enter 로 저장한다', async () => {
    const patch = vi.spyOn(watchlistApi, 'updateMemo').mockResolvedValue(MEMOS[0]);
    renderPanel();
    fireEvent.click(await screen.findByTestId('watchlist-memo-m_0000000a-edit'));
    const input = screen.getByTestId('watchlist-memo-m_0000000a-input');
    fireEvent.change(input, { target: { value: '수정된 메모' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(patch).toHaveBeenCalledWith('m_0000000a', '수정된 메모'));
  });

  it('Escape 는 취소한다 — 저장을 부르지 않는다', async () => {
    const patch = vi.spyOn(watchlistApi, 'updateMemo').mockResolvedValue(MEMOS[0]);
    renderPanel();
    fireEvent.click(await screen.findByTestId('watchlist-memo-m_0000000a-edit'));
    const input = screen.getByTestId('watchlist-memo-m_0000000a-input');
    fireEvent.change(input, { target: { value: '버릴 내용' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(patch).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText('실적 발표 대기')).toBeInTheDocument());
  });

  it('값이 그대로면 저장을 부르지 않는다(빈 PATCH 방지)', async () => {
    const patch = vi.spyOn(watchlistApi, 'updateMemo').mockResolvedValue(MEMOS[0]);
    renderPanel();
    fireEvent.click(await screen.findByTestId('watchlist-memo-m_0000000a-edit'));
    fireEvent.keyDown(screen.getByTestId('watchlist-memo-m_0000000a-input'), { key: 'Enter' });
    expect(patch).not.toHaveBeenCalled();
  });

  it('편집 중 키가 행 네비게이션으로 새지 않는다', async () => {
    renderPanel();
    fireEvent.click(await screen.findByTestId('watchlist-memo-m_0000000a-edit'));
    const input = screen.getByTestId('watchlist-memo-m_0000000a-input');
    // 드로어가 [data-quote-nav] 이고 종목 행이 ↑↓·Delete 를 잡는다. 입력 중 그 키가
    // 위로 새면 행 삭제나 차트 전환이 오발동한다.
    for (const key of ['ArrowDown', 'ArrowUp', 'Delete', 'Enter']) {
      const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      const stopped = vi.fn();
      ev.stopPropagation = stopped;
      input.dispatchEvent(ev);
      expect(stopped).toHaveBeenCalled();
    }
  });

  it('삭제 버튼이 그 메모만 지운다', async () => {
    const del = vi.spyOn(watchlistApi, 'removeMemo').mockResolvedValue();
    renderPanel();
    await screen.findByTestId('watchlist-memo-m_0000000a');
    fireEvent.click(screen.getByTestId('watchlist-memo-m_0000000a-delete'));
    await waitFor(() => expect(del).toHaveBeenCalledWith('m_0000000a'));
  });

  it('그룹 ⋯ 메뉴의 "빈칸 추가"가 그룹 맨 아래에 넣는다(at 미지정)', async () => {
    const add = vi.spyOn(watchlistApi, 'addMemo').mockResolvedValue({
      id: 'm_0000000b', folder_id: 'f_0000000a', order: 3, text: '',
    });
    renderPanel();
    await screen.findByTestId('watchlist-row-005930');
    fireEvent.click(screen.getByLabelText('스윙 그룹 메뉴'));
    fireEvent.click(screen.getByText('빈칸 추가'));
    await waitFor(() => expect(add).toHaveBeenCalledWith('f_0000000a', '', undefined));
  });

  it('행 우클릭 "위에 빈칸 삽입"이 그 행의 items 인덱스로 넣는다', async () => {
    const add = vi.spyOn(watchlistApi, 'addMemo').mockResolvedValue({
      id: 'm_0000000b', folder_id: 'f_0000000a', order: 2, text: '',
    });
    renderPanel();
    // 000660 은 items 인덱스 2 — 그 자리에 넣으면 000660 이 한 칸 밀린다.
    fireEvent.contextMenu(await screen.findByTestId('watchlist-row-000660'));
    fireEvent.click(screen.getByText('위에 빈칸 삽입'));
    await waitFor(() => expect(add).toHaveBeenCalledWith('f_0000000a', '', 2));
  });

  it('등락률 정렬 중에는 "위에 빈칸 삽입"이 없다 — "위에"가 본 자리를 못 가리킨다', async () => {
    renderPanel();
    await screen.findByTestId('watchlist-row-000660');
    fireEvent.click(screen.getByLabelText('스윙 정렬'));   // default → change_pct_desc
    await waitFor(() =>
      expect(screen.queryByTestId('watchlist-memo-m_0000000a')).not.toBeInTheDocument());
    fireEvent.contextMenu(screen.getByTestId('watchlist-row-000660'));
    // 화면 순서는 등락률, order 는 저장 순서라 두 축이 갈린다. 게다가 메모가 숨겨져
    // 결과도 안 보인다 → 항목 자체를 띄우지 않는다.
    expect(screen.queryByText('위에 빈칸 삽입')).not.toBeInTheDocument();
    // 그룹 ⋯ 의 "빈칸 추가"(맨 아래)는 위치 모호성이 없어 그대로 남는다
    fireEvent.click(screen.getByLabelText('스윙 그룹 메뉴'));
    expect(screen.getByText('빈칸 추가')).toBeInTheDocument();
  });

  it('미분류 행에는 "위에 빈칸 삽입"이 없다 — 담을 폴더가 없다', async () => {
    renderPanel({
      ...DATA,
      entries: [{ ...ENTRIES[0], folder_id: null }],
      memos: [],
    });
    fireEvent.contextMenu(await screen.findByTestId('watchlist-row-005930'));
    expect(screen.queryByText('위에 빈칸 삽입')).not.toBeInTheDocument();
  });

  it('등락률 정렬을 켜면 메모가 숨는다 — 위치가 의미를 잃기 때문', async () => {
    renderPanel();
    await screen.findByTestId('watchlist-memo-m_0000000a');
    fireEvent.click(screen.getByLabelText('스윙 정렬'));   // default → change_pct_desc
    await waitFor(() =>
      expect(screen.queryByTestId('watchlist-memo-m_0000000a')).not.toBeInTheDocument());
    // 종목 행은 그대로 남는다
    expect(screen.getByTestId('watchlist-row-005930')).toBeInTheDocument();
  });

  it('그룹 헤더 개수는 종목만 센다 — 메모는 빠진다', async () => {
    renderPanel();
    await screen.findByTestId('watchlist-memo-m_0000000a');
    expect(screen.getByLabelText('스윙 2')).toBeInTheDocument();  // 메모 포함이면 3
  });
});
