import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import type { LiveStudySaveSource } from './studySaveSource';
import { LiveStudyViewSaveButton } from './LiveStudyViewSaveButton';

const createMutate = vi.fn();

vi.mock('./useStudyViews', () => ({
  useStudyViewMutations: () => ({
    create: { mutate: createMutate },
    update: { mutate: vi.fn() },
    remove: { mutate: vi.fn() },
  }),
}));

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
    volume_distributions: [],
    investorPoints: [],
    ask_peaks: [],
    broker_late_entries: [],
  };
}

beforeEach(() => {
  createMutate.mockReset();
});

// 창이 아직 저장 가능한 상태가 아니면(번들 미도착·미지원 종목) source=null.
it('is disabled until a live chart can be saved', () => {
  render(<LiveStudyViewSaveButton source={null} />);

  expect(screen.getByRole('button', { name: '현재 뷰 저장' })).toBeDisabled();
});

it('opens create dialog and creates from the live source', async () => {
  const source: LiveStudySaveSource = {
    origin: 'live',
    code: '005930',
    label: '삼성전자',
    timeframe: '5m',
    bundle: rangeBundleFixture(),
    captureViewport: () => ({ rightEdgeMs: 2_000, barSpan: 2, atLiveEdge: true, rightPaddingBars: 13 }),
  };
  render(<LiveStudyViewSaveButton source={source} />);

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
  expect(body.range).toMatchObject({ from_ms: 1_000, to_ms: 2_000 });
  expect('snapshot' in body).toBe(false);
  expect('indicator_state' in body).toBe(false);
  expect('panePrefsByTimeframe' in body).toBe(false);
  expect(body.viewport.at_live_edge).toBe(true);
  expect(body.viewport.right_padding_bars).toBe(13);
});
