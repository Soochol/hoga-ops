import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Capture from './Capture';
import type { ReactNode } from 'react';
import { stockInstrument } from '../live/liveInstrument';
import { useLivePageStore } from '../state/livePage';

vi.mock('../api/eventStream', () => ({
  subscribeToCaptureEvents: () => () => {},
}));

function W(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  useLivePageStore.setState({ activeInstrument: null, activeCode: null });
  vi.spyOn(globalThis, 'fetch' as 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
    const s = String(url);
    if (s.includes('/api/symbols/all')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          symbols: [
            {
              code: '005930',
              name: '삼성전자',
              market: 'KOSPI',
              captured_count: 0,
              captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 },
            },
          ],
          status: 'fresh',
          fetched_at_ms: 1,
        }),
      } as Response;
    }
    if (s.includes('/api/captures/queue')) return { ok: true, status: 200, json: async () => ({ active: [], queued: [], done: [], paused: false, max_concurrent: 3 }) } as Response;
    if (s.includes('/api/stock-dates')) return { ok: true, status: 200, json: async () => [] } as Response;
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
});

describe('Capture page', () => {
  it('renders both the form panel (left) and the queue panel (right)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<Capture />, { wrapper: W(qc) });
    // queue-empty 는 큐 쿼리 resolve 후에야 뜬다 — 벽시계 대신 이 등장을 기다린다.
    await screen.findByTestId('queue-empty');
    // 페이지 통일(2026-07-23): flat — 그림자·카드 배경 스텝 제거, 필드(--bg)에 평평.
    expect(screen.getByTestId('capture-form-pane')).toHaveClass('bg-bg');
    expect(screen.getByTestId('capture-form-pane')).not.toHaveClass('border');
    expect(screen.getByTestId('capture-form-pane')).not.toHaveClass('shadow-panel');
    expect(screen.getByTestId('capture-queue-pane')).toHaveClass('bg-bg');
    expect(screen.getByTestId('capture-queue-pane')).not.toHaveClass('border');
    expect(screen.getByTestId('capture-queue-pane')).not.toHaveClass('shadow-panel');
    expect(screen.getByPlaceholderText(/종목/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /캡처 시작/ })).toBeTruthy();
    // Queue side hidden by empty-state when no rows. Check that empty state
    // marker renders — this confirms CaptureQueue mounted on the right.
    expect(screen.getByTestId('queue-empty')).toBeTruthy();
    expect(screen.getByPlaceholderText(/종목/i).closest('[data-testid="capture-form-pane"]')).not.toBeNull();
    expect(screen.getByTestId('queue-empty').closest('[data-testid="capture-queue-pane"]')).not.toBeNull();
  });

  // 두 패널 모두 줄어들 수 있어야 한다. 예전에는 큐 쪽에만 min-h-0 이 있어, 폼의
  // overflow-y-auto 스크롤러가 콘텐츠 높이에서 줄지 않은 채 패널의 overflow-hidden 이
  // 폼 하단을 조용히 먹었다(자체 스크롤바도 안 뜸).
  it('lets both sections shrink inside the fixed capture viewport', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<Capture />, { wrapper: W(qc) });
    await screen.findByTestId('queue-empty');

    expect(screen.getByRole('region', { name: '캡처 대기열' })).toHaveClass('min-h-0');
    expect(screen.getByRole('region', { name: '캡처 요청' })).toHaveClass('min-h-0');
  });

  // 행 트랙을 비워두면 grid-auto-rows:auto 가 되고 콘텐츠 높이가 바닥이 된다 — 창을
  // 줄여도 두 패널이 짧아지지 않고 뷰포트 밖으로 잘렸다(#730 과 같은 축 비대칭).
  it('constrains the grid row track so the panes can shorten', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(<Capture />, { wrapper: W(qc) });
    await screen.findByTestId('queue-empty');

    expect(container.firstElementChild).toHaveClass('grid-rows-[minmax(0,1fr)]');
  });

  // 열 트랙(2026-08-07, 드래그 스플리터 폐지). jsdom 은 grid 를 계산하지 않으므로 이건
  // **폭 검증이 아니라 트랙 문자열 회귀 가드**다 — 실제 폭은 브라우저 실측으로 잡았고
  // 유도 과정은 Capture.tsx 주석에 있다. 이 단언이 막는 것 두 가지:
  //   ① 폼 하한을 `auto` 로 되돌리는 것 — 폼 안 overflow-y-auto 때문에 min 이 0으로
  //      풀려 960px 뷰포트에서 폼이 260px 로 짜부러진다.
  //   ② 큐 하한(38.5rem)을 지우는 것 — 1fr 의 min 은 0이라 좁아질 때 큐가 전부 흡수해
  //      취소(×) 열이 가로 스크롤 뒤로 밀린다.
  // 못 보는 것: 값이 여전히 **옳은지**. 달력 트랙(`repeat(7,2rem)`)이나 큐 행 그리드
  // 폭이 바뀌면 이 테스트는 통과한 채로 값만 낡는다 — 그때는 다시 실측할 것.
  it('폼 열은 상·하한이 박힌 고정 트랙이고 큐 열이 남은 폭을 가져간다', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(<Capture />, { wrapper: W(qc) });
    await screen.findByTestId('queue-empty');

    expect(container.firstElementChild).toHaveClass(
      'grid-cols-[minmax(32rem,37rem)_minmax(38.5rem,1fr)]',
    );
    // 드래그 스플리터는 제거됐다(VerticalSplitter 삭제).
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('prefills the symbol from the active live stock when capture has no code query', async () => {
    useLivePageStore.setState({
      activeInstrument: stockInstrument('005930', '삼성전자'),
      activeCode: '005930',
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<Capture />, { wrapper: W(qc) });

    // prefill 은 /api/symbols/all resolve 가 게이트(CaptureForm 의 render-adjust 패턴)라
    // 고정 sleep 대신 값이 반영될 때까지 폴링한다.
    await waitFor(() => {
      expect((screen.getByPlaceholderText(/종목/i) as HTMLInputElement).value).toContain('삼성전자');
    });
  });

  // 큐(우측) → 폼(좌측) 방향의 유일한 연결. 두 pane 은 형제라 서로를 직접 못 보고,
  // 이 페이지가 seq 를 매겨 "선택 이벤트"로 내려보낸다.
  it('큐 행을 클릭하면 좌측 캡처 요청 폼에 그 종목이 선택된다', async () => {
    vi.spyOn(globalThis, 'fetch' as 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
      const s = String(url);
      if (s.includes('/api/symbols/all')) {
        return { ok: true, status: 200, json: async () => ({
          symbols: [{ code: '005930', name: '삼성전자', market: 'KOSPI', captured_count: 0,
                      captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 } }],
          status: 'fresh', fetched_at_ms: 1,
        }) } as Response;
      }
      if (s.includes('/api/captures/queue')) {
        return { ok: true, status: 200, json: async () => ({
          active: [], queued: [], paused: false, max_concurrent: 3,
          done: [{
            item_id: 'i1', code: '005930', date: '20260518', phase: 'done',
            force_retry: false, pause_origin: false, enqueued_at_ms: 1, started_at_ms: null,
            progress: null, result: null, error: null, skip_reason: null, attempt: 1,
          }],
        }) } as Response;
      }
      if (s.includes('/api/stock-dates')) return { ok: true, status: 200, json: async () => [] } as Response;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<Capture />, { wrapper: W(qc) });

    const row = await screen.findByTestId('queue-row-i1');
    expect((screen.getByPlaceholderText(/종목/i) as HTMLInputElement).value).toBe('');

    fireEvent.click(row);

    await waitFor(() => {
      expect((screen.getByPlaceholderText(/종목/i) as HTMLInputElement).value).toContain('삼성전자');
    });
  });
});
