import { describe, expect, it } from 'vitest';
import type { StudyViewReference } from '../api/studyViews';
import type { RangeBundle } from '../api/types';
import type { LiveStudySaveSource, ReferenceStudySaveSource } from './studySaveSource';
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
  it('builds a create command from a live source using captured viewport and empty dialog name', () => {
    const source: LiveStudySaveSource = {
      origin: 'live',
      code: '005930',
      label: '삼성전자',
      timeframe: '5m',
      bundle: bundle(),
      captureViewport: () => ({ rightEdgeMs: 3_000, barSpan: 2, atLiveEdge: true }),
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
      viewport: { right_edge_ms: 3_000, bar_span: 2, at_live_edge: true },
      range: {
        from_ms: 1_000,
        to_ms: 3_000,
      },
    });
    expect('snapshot' in command!.request).toBe(false);
    expect('indicator_state' in command!.request).toBe(false);
    expect(studySaveCommandBody(command!, { name: '복기', memo: '메모' })).toMatchObject({
      name: '복기',
      memo: '메모',
      range: command!.request.range,
    });
  });

  it('builds an overwrite command from a study reference source carrying existing name and memo', () => {
    const save = savedView();
    const source: ReferenceStudySaveSource = {
      origin: 'study-reference',
      viewId: 'view1',
      save,
      bundle: bundle(),
      captureViewport: () => ({ rightEdgeMs: 2_000, barSpan: 1, atLiveEdge: false }),
    };

    const command = makeStudySaveCommand({ mode: 'overwrite', source, existingSave: save });

    expect(command).toMatchObject({
      mode: 'overwrite',
      id: 'view1',
      dialog: {
        defaultName: '기존 저장뷰',
        defaultMemo: '기존 메모',
        rangeLabel: '19700101 ~ 19700101',
      },
    });
    expect(command?.request).toMatchObject({
      name: '기존 저장뷰',
      memo: '기존 메모',
      viewport: { right_edge_ms: 2_000, bar_span: 1, at_live_edge: false },
      range: {
        from_ms: 1_000,
        to_ms: 3_000,
      },
    });
    expect('snapshot' in command!.request).toBe(false);
    expect('indicator_state' in command!.request).toBe(false);
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
