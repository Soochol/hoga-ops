import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { LiveStudySaveSource } from './studySaveCommand';
import { LiveStudyViewSaveButton } from './LiveStudyViewSaveButton';

const createMutate = vi.fn();
const coveragePreviewMock = vi.hoisted(() => vi.fn());
const bulkItemsMock = vi.hoisted(() => vi.fn());

vi.mock('./useStudyViews', () => ({
  useStudyViewMutations: () => ({
    create: { mutate: createMutate },
    update: { mutate: vi.fn() },
    remove: { mutate: vi.fn() },
  }),
}));

vi.mock('../api/captures', () => ({
  coveragePreview: coveragePreviewMock,
  bulkItems: bulkItemsMock,
}));

// 2년 보존 클램프가 벽시계를 읽는다 — 고정하지 않으면 픽스처가 늙어 뒤집힌다.
const TODAY_MS = Date.UTC(2026, 5, 16, 5, 0); // 2026-06-16 14:00 KST
const BAR1 = Date.UTC(2026, 5, 16, 0, 30); // 09:30 KST
const BAR2 = Date.UTC(2026, 5, 16, 0, 35);

beforeAll(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(TODAY_MS);
});
afterAll(() => {
  vi.useRealTimers();
});

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function rangeBundleFixture() {
  return {
    code: '005930',
    from_date: '20260616',
    to_date: '20260616',
    bucket_ms: 300_000,
    segments: [{ date: '20260616', session_open_ms: BAR1, session_close_ms: BAR2 + 300_000 }],
    candles: [
      { ts_ms: BAR1, open: 1, high: 2, low: 1, close: 2, vol_a: 10, vol_b: 0 },
      { ts_ms: BAR2, open: 2, high: 3, low: 2, close: 3, vol_a: 11, vol_b: 0 },
    ],
    quote_ratio: {
      bucket_ms: 300_000,
      points: [{ t: BAR1, bid_total: 100, ask_total: 90, bid_max: 0, ask_max: 0, imb_max_bid: 0, imb_max_ask: 0 }],
    },
    study_ratio: { bucket_ms: 300_000, points: [{ t: BAR1, value: 0.1 }] },
    fill_strength: { bucket_ms: 300_000, points: [{ t: BAR1, buy_qty: 5, sell_qty: 4 }] },
    volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_by_day: [],
    volume_distributions: [],
    investorPoints: [],
    ask_peaks: [],
    broker_late_entries: [],
  };
}

function liveSource(): LiveStudySaveSource {
  return {
    origin: 'live',
    code: '005930',
    label: '삼성전자',
    timeframe: '5m',
    bundle: rangeBundleFixture(),
    captureViewport: () => ({
      rightEdgeMs: BAR2, leftEdgeMs: BAR1, barSpan: 2, atLiveEdge: true, rightPaddingBars: 13,
    }),
  };
}

beforeEach(() => {
  createMutate.mockReset();
  bulkItemsMock.mockReset();
  bulkItemsMock.mockResolvedValue({ enqueued: 1, deduped: 0, blocked: 0, failed: 0, codes: 1 });
  coveragePreviewMock.mockReset();
  coveragePreviewMock.mockResolvedValue({
    dates: ['20260616'],
    codes: 1,
    total: 1,
    have: 0,
    no_upstream: 0,
    to_collect: 1,
    est_minutes: 2,
    missing: [{ code: '005930', date: '20260616' }],
  });
});

// 창이 아직 저장 가능한 상태가 아니면(번들 미도착·미지원 종목) source=null.
it('is disabled until a live chart can be saved', () => {
  render(<LiveStudyViewSaveButton source={null} />, { wrapper });

  expect(screen.getByRole('button', { name: '현재 뷰 저장' })).toBeDisabled();
});

it('opens create dialog and creates from the live source', async () => {
  render(<LiveStudyViewSaveButton source={liveSource()} />, { wrapper });

  await userEvent.click(screen.getByRole('button', { name: '현재 뷰 저장' }));
  expect(screen.getByRole('dialog', { name: '저장뷰 만들기' })).toBeTruthy();
  expect(screen.getByLabelText('이름')).toHaveValue('');
  await userEvent.type(screen.getByLabelText('이름'), ' 라이브 저장 ');
  await userEvent.click(screen.getByRole('button', { name: '저장' }));

  expect(createMutate).toHaveBeenCalledTimes(1);
  const body = createMutate.mock.calls[0][0];
  expect(body.name).toBe('라이브 저장');
  expect(body.code).toBe('005930');
  expect(body.label).toBe('삼성전자');
  expect(body.range).toMatchObject({ from_ms: BAR1, to_ms: BAR2 });
  expect('snapshot' in body).toBe(false);
  expect('indicator_state' in body).toBe(false);
  expect('panePrefsByTimeframe' in body).toBe(false);
  expect(body.viewport.at_live_edge).toBe(true);
  expect(body.viewport.right_padding_bars).toBe(13);
  expect(body.viewport.left_edge_ms).toBe(BAR1);
});

// 커버리지는 읽기 전용 미리보기 — 저장 구간 그대로 물어본다.
it('previews hogaplay coverage for the saved range', async () => {
  render(<LiveStudyViewSaveButton source={liveSource()} />, { wrapper });

  await userEvent.click(screen.getByRole('button', { name: '현재 뷰 저장' }));

  await waitFor(() => expect(coveragePreviewMock).toHaveBeenCalledWith({
    codes: ['005930'],
    start_date: '20260616',
    end_date: '20260616',
  }));
  expect(await screen.findByLabelText('빠진 기간 수집')).toBeChecked();
});

// missing 만 넘긴다 — 이미 COMPLETE 인 날짜를 다시 넣으면 already_complete 스킵이
// fail_streak 를 태워(ATTEMPT_CAP=5) 반복 저장이 자기 종목을 막는다.
it('enqueues only the missing dates after a successful save', async () => {
  createMutate.mockImplementation((_body, opts) => opts?.onSuccess?.());
  render(<LiveStudyViewSaveButton source={liveSource()} />, { wrapper });

  await userEvent.click(screen.getByRole('button', { name: '현재 뷰 저장' }));
  await screen.findByLabelText('빠진 기간 수집');
  await userEvent.type(screen.getByLabelText('이름'), '라이브 저장');
  await userEvent.click(screen.getByRole('button', { name: '저장' }));

  await waitFor(() => expect(bulkItemsMock).toHaveBeenCalledTimes(1));
  expect(bulkItemsMock.mock.calls[0][0]).toEqual([{ code: '005930', date: '20260616' }]);
});

it('skips capture when the user unchecks it', async () => {
  createMutate.mockImplementation((_body, opts) => opts?.onSuccess?.());
  render(<LiveStudyViewSaveButton source={liveSource()} />, { wrapper });

  await userEvent.click(screen.getByRole('button', { name: '현재 뷰 저장' }));
  await userEvent.click(await screen.findByLabelText('빠진 기간 수집'));
  await userEvent.type(screen.getByLabelText('이름'), '라이브 저장');
  await userEvent.click(screen.getByRole('button', { name: '저장' }));

  await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1));
  expect(bulkItemsMock).not.toHaveBeenCalled();
});
