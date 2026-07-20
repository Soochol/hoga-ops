import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
    // 부유 카드 모델(2026-07-15): borderless — --bg-card + shadow-panel 만으로 분리.
    expect(screen.getByTestId('capture-form-pane')).toHaveClass('bg-bg-card');
    expect(screen.getByTestId('capture-form-pane')).not.toHaveClass('border');
    expect(screen.getByTestId('capture-form-pane')).toHaveClass('shadow-panel');
    expect(screen.getByTestId('capture-queue-pane')).toHaveClass('bg-bg-card');
    expect(screen.getByTestId('capture-queue-pane')).not.toHaveClass('border');
    expect(screen.getByTestId('capture-queue-pane')).toHaveClass('shadow-panel');
    expect(screen.getByPlaceholderText(/종목/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Start/i })).toBeTruthy();
    // Queue side hidden by empty-state when no rows. Check that empty state
    // marker renders — this confirms CaptureQueue mounted on the right.
    expect(screen.getByTestId('queue-empty')).toBeTruthy();
    expect(screen.getByPlaceholderText(/종목/i).closest('.bg-bg-card')).not.toBeNull();
    expect(screen.getByTestId('queue-empty').closest('.bg-bg-card')).not.toBeNull();
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
  it('constrains the splitter grid row track so the panes can shorten', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(<Capture />, { wrapper: W(qc) });
    await screen.findByTestId('queue-empty');

    expect(container.firstElementChild).toHaveClass('grid-rows-[minmax(0,1fr)]');
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
});
