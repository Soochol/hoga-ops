import { describe, expect, it } from 'vitest';
import type { StudyViewReference } from '../api/studyViews';
import type { RangeBundle } from '../api/types';
import type { LiveStudySaveSource } from './studySaveCommand';
import { makeStudySaveCommand, studySaveCommandBody } from './studySaveCommand';

function bundle(overrides: Partial<RangeBundle> = {}): RangeBundle {
  return {
    code: '005930',
    from_date: '20260616',
    to_date: '20260616',
    bucket_ms: 300_000,
    segments: [{ date: '20260616', session_open_ms: 1_000, session_close_ms: 4_000 }],
    candles: [
      { ts_ms: 1_000, open: 1, high: 2, low: 1, close: 2, vol_a: 10, vol_b: 0 },
      { ts_ms: 2_000, open: 2, high: 3, low: 2, close: 3, vol_a: 11, vol_b: 0 },
      { ts_ms: 3_000, open: 3, high: 4, low: 3, close: 4, vol_a: 12, vol_b: 0 },
    ],
    quote_ratio: {
      bucket_ms: 300_000,
      points: [{ t: 1_000, bid_total: 100, ask_total: 90, bid_max: 0, ask_max: 0, imb_max_bid: 0, imb_max_ask: 0 }],
    },
    fill_strength: { bucket_ms: 300_000, points: [{ t: 1_000, buy_qty: 5, sell_qty: 4 }] },
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
    range: { from_date: '19700101', to_date: '19700101', from_ms: 1_000, to_ms: 3_000 },
    viewport: { right_edge_ms: 3_000, bar_span: 2, at_live_edge: false },
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
      captureViewport: () => ({ rightEdgeMs: 2_000, barSpan: 1, atLiveEdge: false, rightPaddingBars: 7 }),
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
      captureViewport: () => ({ rightEdgeMs: 3_000, barSpan: 2, atLiveEdge: true, rightPaddingBars: 18 }),
    };

    const command = makeStudySaveCommand({ mode: 'create', source, existingSave: null });

    expect(command).toMatchObject({
      mode: 'create',
      id: undefined,
      dialog: {
        defaultName: '',
        defaultMemo: '',
        rangeLabel: '19700101 ~ 19700101',
      },
    });
    expect(command?.request).toMatchObject({
      name: '삼성전자 5m 저장뷰',
      code: '005930',
      label: '삼성전자',
      viewport: { right_edge_ms: 3_000, bar_span: 2, at_live_edge: true, right_padding_bars: 18 },
      // 저장 범위는 보이는 캔들(bar_span=2 → 마지막 2봉)만 — 최소 봉수 확장 없음.
      range: {
        from_ms: 2_000,
        to_ms: 3_000,
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
