import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import type { CurrentStudySaveSource } from './studySaveSource';
import { LiveStudyViewSaveButton } from './LiveStudyViewSaveButton';

const createMutate = vi.fn();
let saveSource: CurrentStudySaveSource | null = null;

const indicatorState = {
  volume_enabled: true,
  quote_totals_enabled: true,
  ratio_enabled: true,
  fill_strength_enabled: true,
  aggregation_basis: 'close' as const,
  auction_window_mask: true,
  ratio_outlier_filter_enabled: true,
  ratio_outlier_threshold: 50,
};

vi.mock('./useStudyViews', () => ({
  useStudyViewMutations: () => ({
    create: { mutate: createMutate },
    update: { mutate: vi.fn() },
    remove: { mutate: vi.fn() },
  }),
}));

vi.mock('./studySaveSource', () => ({
  useCurrentStudySaveSource: () => saveSource,
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
    investorPoints: [],
    ask_peaks: [],
  };
}

beforeEach(() => {
  createMutate.mockReset();
  saveSource = null;
});

it('is disabled until a live chart can be saved', () => {
  render(<LiveStudyViewSaveButton />);

  expect(screen.getByRole('button', { name: '현재 뷰 저장' })).toBeDisabled();
});

it('opens create dialog and creates from the live source', async () => {
  saveSource = {
    origin: 'live',
    code: '005930',
    label: '삼성전자',
    timeframe: '5m',
    bundle: rangeBundleFixture(),
    indicatorState,
    captureViewport: () => ({ rightEdgeMs: 2_000, barSpan: 2, atLiveEdge: true }),
  };
  render(<LiveStudyViewSaveButton />);

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
  expect(body.provenance.saved_from_route).toBe('/live');
  expect(body.viewport.at_live_edge).toBe(true);
});
