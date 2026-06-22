import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as api from '../api/watchlist';
import { WatchlistEditModal } from './WatchlistEditModal';

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
const DATA = {
  folders: [{ id: 'f_a', name: '스윙', order: 0, capture_enabled: true }],
  entries: [{ code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_a', order: 0 }],
  next_run_at_ms: 0,
};

describe('WatchlistEditModal', () => {
  beforeEach(() => { cleanup(); vi.restoreAllMocks(); });
  it('renders dialog with folder list (v3: no 미분류, no 모든 종목)', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEditModal onClose={() => {}} />, { wrapper: wrap(qc) });
    expect(await screen.findByRole('dialog', { name: '관심종목 편집' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('스윙')).toBeInTheDocument());
    expect(screen.queryByText('미분류')).not.toBeInTheDocument();   // v3: 미분류 폐지
    expect(screen.queryByText('모든 종목')).not.toBeInTheDocument();
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

  it('renames and deletes a folder via its row actions', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
    const ren = vi.spyOn(api, 'renameFolder').mockResolvedValue();
    const del = vi.spyOn(api, 'deleteFolder').mockResolvedValue();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEditModal onClose={() => {}} />, { wrapper: wrap(qc) });
    await screen.findByText('스윙');
    fireEvent.click(screen.getByLabelText('스윙 이름변경'));
    const input = screen.getByDisplayValue('스윙');
    fireEvent.change(input, { target: { value: '단타' } });
    fireEvent.blur(input);
    await waitFor(() => expect(ren).toHaveBeenCalledWith('f_a', '단타'));
    fireEvent.click(screen.getByLabelText('스윙 삭제'));
    await waitFor(() => expect(del).toHaveBeenCalledWith('f_a'));
  });

  it('Escape during folder rename cancels the rename without closing the modal', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue(DATA);
    const ren = vi.spyOn(api, 'renameFolder').mockResolvedValue();
    const onClose = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEditModal onClose={onClose} />, { wrapper: wrap(qc) });
    await screen.findByText('스윙');
    fireEvent.click(screen.getByLabelText('스윙 이름변경'));
    const input = screen.getByDisplayValue('스윙');
    fireEvent.change(input, { target: { value: '단타' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    // rename is cancelled (input gone, no mutation) and the modal stays open
    await waitFor(() => expect(screen.getByText('스윙')).toBeInTheDocument());
    expect(ren).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('reorders folders via ▼ (move down) — authoritative ordered_ids', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue({
      folders: [
        { id: 'f_a', name: '스윙', order: 0, capture_enabled: true },
        { id: 'f_b', name: '장기', order: 1, capture_enabled: true },
      ],
      entries: [], next_run_at_ms: 0,
    });
    const ro = vi.spyOn(api, 'reorderFolders').mockResolvedValue();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEditModal onClose={() => {}} />, { wrapper: wrap(qc) });
    await screen.findByText('스윙');
    fireEvent.click(screen.getByLabelText('스윙 아래로'));
    await waitFor(() => expect(ro).toHaveBeenCalledWith(['f_b', 'f_a']));
  });

  it('resets selection to 미분류 when the currently-selected folder is deleted', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue({
      folders: [{ id: 'f_a', name: '스윙', order: 0, capture_enabled: true }],
      entries: [
        { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null, folder_id: 'f_a', order: 0 },
        { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null, folder_id: null, order: 0 },
      ],
      next_run_at_ms: 0,
    });
    vi.spyOn(api, 'deleteFolder').mockResolvedValue();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistEditModal onClose={() => {}} />, { wrapper: wrap(qc) });
    await screen.findByText('스윙');
    // select 스윙 → pane filters to its member only (미분류 000660 hidden)
    fireEvent.click(screen.getByText('스윙'));
    await waitFor(() => expect(screen.queryByText('SK하이닉스')).not.toBeInTheDocument());
    // delete the selected folder → selection falls back to 미분류 (not a stale empty pane):
    // its member (000660) shows; the deleted folder's member (005930) does not.
    fireEvent.click(screen.getByLabelText('스윙 삭제'));
    await waitFor(() => expect(screen.getByText('SK하이닉스')).toBeInTheDocument());
    expect(screen.queryByText('삼성전자')).not.toBeInTheDocument();
  });

  it('renders and toggles folder capture setting', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue({
      folders: [{ id: 'f_a', name: '스윙', order: 0, capture_enabled: false }],
      entries: [],
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

    const toggle = await screen.findByRole('switch', { name: '스윙 저장 대상' });
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);

    await waitFor(() => expect(setCapture).toHaveBeenCalledWith('f_a', true));
  });

  it('defaults missing folder capture state to enabled in the edit modal', async () => {
    vi.spyOn(api, 'getWatchlist').mockResolvedValue({
      folders: [{ id: 'f_a', name: '스윙', order: 0 }],
      entries: [],
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

    const toggle = await screen.findByRole('switch', { name: '스윙 저장 대상' });
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);

    await waitFor(() => expect(setCapture).toHaveBeenCalledWith('f_a', false));
  });
});
