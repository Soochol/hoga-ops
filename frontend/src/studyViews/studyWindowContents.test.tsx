/**
 * `/study` 10호가 창 — **프레임 일관성** 회귀 가드 (2026-08-20).
 *
 * 이 창은 한 화면에 두 속도의 자료를 섞는다: 사다리만 네트워크(`/api/orderbook`)고
 * 등락률 분모·체결강도·시고저는 전부 로컬 파생이라 커서를 따라 **즉시** 바뀐다.
 * 분모를 커서 날짜로 잡으면 조회가 비행 중일 때 **분자는 옛 날짜 · 분모는 새 날짜**인
 * 프레임이 뜬다 — 사용자 신고와 실측이 정확히 그것이었다(010140, 같은 가격 26,050 이
 * −1.51% → +2.76% 로 바뀌는데 잔량 10줄은 한 자리도 안 움직였다).
 *
 * 그래서 분모의 날짜는 **사다리 자신의 `ts_ms`** 여야 한다. 아래 첫 테스트가 그것을
 * 잰다 — 커서와 스냅샷의 날짜를 일부러 갈라 놓고 조회 창이 어느 쪽을 따르는지 본다.
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LiveOrderbookSpotResult } from '../api/useLiveCursor';
import type { StudyViewReference } from '../api/studyViews';
import type { OrderbookSnapshot, RangeBundle } from '../api/types';
import { useLiveCursorStore } from '../live/useLiveCursorStore';

const useLiveOrderbookAtCursorMock = vi.fn();
const useScreenerDailyCandlesMock = vi.fn();
const bookPanelMock = vi.fn();

vi.mock('../api/useLiveCursor', async (orig) => ({
  ...(await orig<typeof import('../api/useLiveCursor')>()),
  useLiveOrderbookAtCursor: (...args: unknown[]) => useLiveOrderbookAtCursorMock(...args),
  useLiveBrokersAtCursor: () => undefined,
}));

vi.mock('../api/screenerDailyCandles', async (orig) => ({
  ...(await orig<typeof import('../api/screenerDailyCandles')>()),
  useScreenerDailyCandles: (...args: unknown[]) => useScreenerDailyCandlesMock(...args),
}));

// 표시는 BookPanel 의 몫이라 여기서는 **넘어가는 props** 만 본다.
vi.mock('../live/workspace/BookPanel', () => ({
  default: (props: Record<string, unknown>) => {
    bookPanelMock(props);
    return <div data-testid="book-panel" />;
  },
}));

const { StudyDataWindowContent } = await import('./studyWindowContents');

/** 2025-11-21 09:16 KST — 커서가 가리키는 **새** 날짜. */
const CURSOR_MS = Date.UTC(2025, 10, 21, 0, 16);
/** 2025-11-20 09:10 KST — 아직 화면에 남아 있는 **옛** 사다리의 시각. */
const STALE_SNAPSHOT_MS = Date.UTC(2025, 10, 20, 0, 10);

function snapshotAt(tsMs: number): OrderbookSnapshot {
  const ask = [26_500, 26_550].map((price, i) => ({ price, qty: 100 + i }));
  const bid = [26_450, 26_400].map((price, i) => ({ price, qty: 200 + i }));
  return {
    ts_ms: tsMs,
    seq: 1,
    ask,
    bid,
    tot_ask: 201,
    tot_bid: 401,
  };
}

const SAVE: StudyViewReference = {
  schema_version: 2,
  id: 'view-1',
  name: 'fixture',
  code: '010140',
  label: '삼성중공업',
  timeframe: '3m',
  range: {
    from_date: '20251120',
    to_date: '20251121',
    from_ms: STALE_SNAPSHOT_MS,
    to_ms: CURSOR_MS,
  },
  viewport: {
    right_edge_ms: CURSOR_MS,
    left_edge_ms: STALE_SNAPSHOT_MS,
    bar_span: 100,
    at_live_edge: false,
    right_padding_bars: null,
  },
  memo: '',
  tags: [],
  created_at_ms: 0,
  updated_at_ms: 0,
};

const BUNDLE = {
  code: '010140',
  from_date: '20251120',
  to_date: '20251121',
  bucket_ms: 180_000,
  segments: [],
  candles: [],
  quote_ratio: { points: [] },
  fill_strength: { points: [] },
  volume_profile_range: { levels: [] },
  volume_profile_by_day: [],
  volume_distributions: [],
} as unknown as RangeBundle;

function spotResult(over: Partial<LiveOrderbookSpotResult> = {}): LiveOrderbookSpotResult {
  return { spot: undefined, stale: false, error: null, ...over };
}

function renderBook() {
  return render(
    <StudyDataWindowContent kind="book" group={1} emptyReason={null} save={SAVE} bundle={BUNDLE} />,
  );
}

/** `useScreenerDailyCandles(code, from, to)` 의 `to` = 분모를 뽑는 기준 날짜. */
function baselineQueryDate(): string | null {
  const last = useScreenerDailyCandlesMock.mock.calls.at(-1);
  return (last?.[2] as string | undefined) ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  useScreenerDailyCandlesMock.mockReturnValue({ data: undefined });
  useLiveCursorStore.getState().resetCursor();
  useLiveCursorStore.getState().setSidebarCursor(CURSOR_MS, {
    windowId: null,
    group: null,
    code: '010140',
    timeframe: '3m',
  });
});

describe('/study 10호가 — 분모의 날짜', () => {
  it('사다리가 뒤처져 있으면 분모도 **사다리 날짜**를 따른다', () => {
    // 커서는 11/21, 화면의 사다리는 아직 11/20 — 이 순간이 버그가 보이던 자리다.
    useLiveOrderbookAtCursorMock.mockReturnValue(
      spotResult({ spot: { snapshot: snapshotAt(STALE_SNAPSHOT_MS), available_from: null, source: 'hogaplay' }, stale: true }),
    );
    renderBook();
    // 커서 날짜(20251121)를 따르면 옛 가격에 새 분모가 붙는다.
    expect(baselineQueryDate()).toBe('20251120');
  });

  it('사다리가 따라잡으면 분모도 함께 옮겨간다', () => {
    useLiveOrderbookAtCursorMock.mockReturnValue(
      spotResult({ spot: { snapshot: snapshotAt(CURSOR_MS), available_from: null, source: 'hogaplay' } }),
    );
    renderBook();
    expect(baselineQueryDate()).toBe('20251121');
  });

  it('사다리가 없으면 커서 날짜로 떨어진다 — 그릴 가격이 없어 무해하다', () => {
    useLiveOrderbookAtCursorMock.mockReturnValue(spotResult());
    renderBook();
    expect(baselineQueryDate()).toBe('20251121');
  });
});

describe('/study 10호가 — 신선도와 실패', () => {
  it('stale 을 BookPanel 로 흘려보낸다', () => {
    useLiveOrderbookAtCursorMock.mockReturnValue(
      spotResult({ spot: { snapshot: snapshotAt(STALE_SNAPSHOT_MS), available_from: null, source: 'hogaplay' }, stale: true }),
    );
    renderBook();
    expect(bookPanelMock.mock.calls.at(-1)?.[0].stale).toBe(true);
  });

  it('조회 실패는 로딩과 **다른 문구**다', () => {
    // `useSpot` 이 실패분을 비우므로 그냥 두면 "커서 위치 불러오는 중…" 이 영원히
    // 뜨는데, 재시도 경로가 없어 그 문구가 거짓말이 된다.
    useLiveOrderbookAtCursorMock.mockReturnValue(spotResult({ error: new Error('boom') }));
    renderBook();
    expect(screen.getByTestId('study-orderbook-error')).toBeInTheDocument();
    expect(screen.queryByTestId('book-panel')).toBeNull();
  });

  it('커서가 없으면 실패 문구를 띄우지 않는다 — 조회한 적이 없다', () => {
    useLiveCursorStore.getState().resetCursor();
    useLiveOrderbookAtCursorMock.mockReturnValue(spotResult({ error: new Error('stale') }));
    renderBook();
    expect(screen.queryByTestId('study-orderbook-error')).toBeNull();
  });
});
