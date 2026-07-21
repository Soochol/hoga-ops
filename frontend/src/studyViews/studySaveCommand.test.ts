import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StudyViewReference } from '../api/studyViews';
import type { RangeBundle } from '../api/types';
import type { LiveStudySaveSource } from './studySaveCommand';
import { makeStudySaveCommand, studySaveCommandBody } from './studySaveCommand';

// 2년 보존 클램프(HOGAPLAY_RETENTION_YEARS)가 벽시계를 읽으므로 시간을 고정한다.
// 고정하지 않으면 픽스처 날짜가 2년을 넘기는 순간 테스트가 조용히 뒤집힌다.
const TODAY_MS = Date.UTC(2026, 5, 16, 5, 0); // 2026-06-16 14:00 KST
const BAR1 = Date.UTC(2026, 5, 16, 0, 30); // 09:30 KST
const BAR2 = Date.UTC(2026, 5, 16, 0, 35);
const BAR3 = Date.UTC(2026, 5, 16, 0, 40);

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TODAY_MS);
});
afterAll(() => {
  vi.useRealTimers();
});

function bundle(overrides: Partial<RangeBundle> = {}): RangeBundle {
  return {
    code: '005930',
    from_date: '20260616',
    to_date: '20260616',
    bucket_ms: 300_000,
    segments: [{ date: '20260616', session_open_ms: BAR1, session_close_ms: BAR3 + 300_000 }],
    candles: [
      { ts_ms: BAR1, open: 1, high: 2, low: 1, close: 2, vol_a: 10, vol_b: 0 },
      { ts_ms: BAR2, open: 2, high: 3, low: 2, close: 3, vol_a: 11, vol_b: 0 },
      { ts_ms: BAR3, open: 3, high: 4, low: 3, close: 4, vol_a: 12, vol_b: 0 },
    ],
    quote_ratio: {
      bucket_ms: 300_000,
      points: [{ t: BAR1, bid_total: 100, ask_total: 90, bid_max: 0, ask_max: 0, imb_max_bid: 0, imb_max_ask: 0 }],
    },
    fill_strength: { bucket_ms: 300_000, points: [{ t: BAR1, buy_qty: 5, sell_qty: 4 }] },
    volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_by_day: [],
    volume_distributions: overrides.volume_distributions ?? [],
    investorPoints: [],
    ask_peaks: [],
    broker_late_entries: [],
    ...overrides,
  };
}

function savedView(overrides: Partial<StudyViewReference> = {}): StudyViewReference {
  return {
    schema_version: 2,
    id: 'view1',
    name: '기존 저장뷰',
    code: '005930',
    label: '삼성전자',
    timeframe: '5m',
    memo: '기존 메모',
    tags: [],
    range: { from_date: '20260616', to_date: '20260616', from_ms: BAR1, to_ms: BAR3 },
    viewport: { right_edge_ms: BAR3, left_edge_ms: BAR2, bar_span: 2, at_live_edge: false },
    created_at_ms: 1,
    updated_at_ms: 2,
    ...overrides,
  };
}

describe('makeStudySaveCommand', () => {
  // 덮어쓰기 대상 id 의 유일한 출처는 `study-reference` 소스의 viewId 였는데,
  // 그 변종은 독자를 잃은 채(저장뷰 드로어 단순화 164f4952) 쓰기만 남아 있다가
  // 정리됐다. 지금 프로덕션 호출부는 'create' 뿐이라 무해하지만, 덮어쓰기를
  // 되살릴 땐 id 출처부터 다시 정해야 한다는 것을 계약으로 못박는다.
  it('cannot resolve an overwrite id — the only source of one is gone', () => {
    const source: LiveStudySaveSource = {
      origin: 'live',
      code: '005930',
      label: '삼성전자',
      timeframe: '5m',
      bundle: bundle(),
      captureViewport: () => ({
        rightEdgeMs: BAR2, leftEdgeMs: BAR2, barSpan: 1, atLiveEdge: false, rightPaddingBars: 7,
      }),
    };

    const command = makeStudySaveCommand({ mode: 'overwrite', source, existingSave: savedView() });

    expect(command?.id).toBeUndefined();
  });

  it('builds a create command from a live source using captured viewport and empty dialog name', () => {
    const source: LiveStudySaveSource = {
      origin: 'live',
      code: '005930',
      label: '삼성전자',
      timeframe: '5m',
      bundle: bundle(),
      captureViewport: () => ({
        rightEdgeMs: BAR3, leftEdgeMs: BAR2, barSpan: 2, atLiveEdge: true, rightPaddingBars: 18,
      }),
    };

    const command = makeStudySaveCommand({ mode: 'create', source, existingSave: null });

    expect(command).toMatchObject({
      mode: 'create',
      id: undefined,
      dialog: {
        defaultName: '',
        defaultMemo: '',
        rangeLabel: '20260616 ~ 20260616',
      },
    });
    expect(command?.request).toMatchObject({
      name: '삼성전자 5m 저장뷰',
      code: '005930',
      label: '삼성전자',
      viewport: {
        right_edge_ms: BAR3, left_edge_ms: BAR2, bar_span: 2, at_live_edge: true, right_padding_bars: 18,
      },
      // 저장 범위는 보이는 캔들만 — 최소 봉수 확장 없음.
      range: {
        from_ms: BAR2,
        to_ms: BAR3,
      },
    });
    expect('snapshot' in command!.request).toBe(false);
    expect('indicator_state' in command!.request).toBe(false);
    expect('panePrefsByTimeframe' in command!.request).toBe(false);
    expect(studySaveCommandBody(command!, { name: '복기', memo: '메모' })).toMatchObject({
      name: '복기',
      memo: '메모',
      range: command!.request.range,
    });
  });


  // 실측 회귀(일봉, 2026-07-21): 라이브 엣지에서 bar_span 은 마지막 캔들 뒤
  // rightOffset 여백(14봉)까지 센다. 좌측을 span 역산으로 구하면 그 여백만큼
  // 과거로 넘쳐 화면엔 12-10 부터인데 저장은 11-19 부터가 됐다.
  it('does not let right-edge whitespace pull the start into history', () => {
    const source: LiveStudySaveSource = {
      origin: 'live',
      code: '005930',
      label: '삼성전자',
      timeframe: '5m',
      bundle: bundle(),
      // span=3 이지만 그중 2봉은 마지막 캔들 뒤 여백 — 실제로 보이는 건 마지막 1봉.
      captureViewport: () => ({
        rightEdgeMs: BAR3, leftEdgeMs: BAR3, barSpan: 3, atLiveEdge: true, rightPaddingBars: 2,
      }),
    };

    const command = makeStudySaveCommand({ mode: 'create', source, existingSave: null });

    expect(command?.request.range).toMatchObject({ from_ms: BAR3, to_ms: BAR3 });
  });

  // 반대 방향 회귀: 과거로 팬하면 여백이 없어 span 역산이 1봉 모자랐고 맨 왼쪽
  // 캔들이 잘렸다. 좌측 앵커는 그 캔들을 포함한다.
  it('keeps the leftmost visible candle when panned back', () => {
    const source: LiveStudySaveSource = {
      origin: 'live',
      code: '005930',
      label: '삼성전자',
      timeframe: '5m',
      bundle: bundle(),
      captureViewport: () => ({
        rightEdgeMs: BAR3, leftEdgeMs: BAR1, barSpan: 2, atLiveEdge: false,
      }),
    };

    const command = makeStudySaveCommand({ mode: 'create', source, existingSave: null });

    expect(command?.request.range).toMatchObject({ from_ms: BAR1, to_ms: BAR3 });
  });

  // 2년 보존 정책: hogaplay 원자료가 없는 구간은 저장해도 복원할 수 없다.
  it('clamps the saved range to the hogaplay retention floor', () => {
    const old1 = Date.UTC(2023, 0, 10, 0, 30); // 3년 전 — 보존 밖
    const old2 = Date.UTC(2024, 0, 10, 0, 30); // 2년 반 전 — 보존 밖
    const source: LiveStudySaveSource = {
      origin: 'live',
      code: '005930',
      label: '삼성전자',
      timeframe: '5m',
      bundle: bundle({
        candles: [
          { ts_ms: old1, open: 1, high: 2, low: 1, close: 2, vol_a: 1, vol_b: 0 },
          { ts_ms: old2, open: 1, high: 2, low: 1, close: 2, vol_a: 1, vol_b: 0 },
          { ts_ms: BAR1, open: 1, high: 2, low: 1, close: 2, vol_a: 1, vol_b: 0 },
          { ts_ms: BAR3, open: 1, high: 2, low: 1, close: 2, vol_a: 1, vol_b: 0 },
        ],
      }),
      // 좌측 끝이 3년 전이어도 저장은 보존 하한(2024-06-16) 이후부터.
      captureViewport: () => ({
        rightEdgeMs: BAR3, leftEdgeMs: old1, barSpan: 4, atLiveEdge: true,
      }),
    };

    const command = makeStudySaveCommand({ mode: 'create', source, existingSave: null });

    expect(command?.request.range).toMatchObject({ from_ms: BAR1, to_ms: BAR3 });
  });

  it('returns null when no viewport can be captured or inferred', () => {
    const source: LiveStudySaveSource = {
      origin: 'live',
      code: '005930',
      label: '삼성전자',
      timeframe: '5m',
      bundle: bundle({ candles: [] }),
      captureViewport: () => null,
    };

    expect(makeStudySaveCommand({ mode: 'create', source, existingSave: null })).toBeNull();
  });
});
