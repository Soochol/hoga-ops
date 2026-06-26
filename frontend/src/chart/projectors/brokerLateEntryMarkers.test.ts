import { describe, expect, it } from 'vitest';

import type { RangeBundle } from '../../api/types';
import { createVirtualAxis } from '../../util/virtualAxis';
import {
  layoutBrokerLateEntryLabels,
  projectBrokerLateEntryMarkers,
} from './brokerLateEntryMarkers';

const OPEN = Date.UTC(2026, 5, 26, 0, 0, 0);
const CLOSE = OPEN + 23_400_000;
const DAY2_OPEN = OPEN + 86_400_000;
const DAY2_CLOSE = DAY2_OPEN + 23_400_000;

function candle(ts_ms: number): RangeBundle['candles'][number] {
  return { ts_ms, open: 1, high: 1, low: 1, close: 1, vol_a: 0, vol_b: 0 };
}

function ratioPoint(
  t: number,
  bid_total: number,
  ask_total: number,
): RangeBundle['quote_ratio']['points'][number] {
  return {
    t,
    bid_total,
    ask_total,
    bid_max: bid_total,
    ask_max: ask_total,
    imb_max_bid: bid_total,
    imb_max_ask: ask_total,
  };
}

function bundle(overrides: Partial<RangeBundle> = {}): RangeBundle {
  return {
    code: '005930',
    from_date: '20260626',
    to_date: '20260626',
    bucket_ms: 60_000,
    segments: [
      { date: '20260626', session_open_ms: OPEN, session_close_ms: CLOSE },
    ],
    candles: [
      candle(OPEN),
      candle(OPEN + 60_000),
      candle(OPEN + 120_000),
      candle(OPEN + 23_220_000),
    ],
    quote_ratio: {
      bucket_ms: 60_000,
      points: [
        ratioPoint(OPEN, 200, 100),
        ratioPoint(OPEN + 120_000, 100, 300),
        ratioPoint(OPEN + 23_220_000, 100, 400),
      ],
    },
    fill_strength: { bucket_ms: 60_000, points: [] },
    volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_by_day: [],
    volume_distributions: [],
    investorPoints: [],
    ask_peaks: [],
    broker_late_entries: [
      { t_ms: OPEN, broker: '삼성증권', side: 'buy', net: 10 },
      { t_ms: OPEN + 120_000, broker: '키움증권', side: 'sell', net: -20 },
    ],
    ...overrides,
  };
}

describe('projectBrokerLateEntryMarkers', () => {
  it('filters by side mode, keeps canonical broker name, and applies side colors', () => {
    const axis = createVirtualAxis([
      { date: '20260626', sessionOpenMs: OPEN, sessionCloseMs: CLOSE },
    ]);

    const markers = projectBrokerLateEntryMarkers(bundle(), axis, {
      auctionWindowMask: false,
      outlierFilterEnabled: false,
      outlierThreshold: 100,
      sideMode: 'buy',
      buyColor: '#ef4444',
      sellColor: '#3b82f6',
    });

    expect(markers).toEqual([
      {
        time: axis.toVirtual(OPEN) / 1000,
        price: -1,
        broker: '삼성증권',
        label: '삼성',
        side: 'buy',
        color: '#ef4444',
      },
    ]);
  });

  it('uses the nearest earlier displayed ratio value in the same session when the exact bucket is absent', () => {
    const axis = createVirtualAxis([
      { date: '20260626', sessionOpenMs: OPEN, sessionCloseMs: CLOSE },
    ]);
    const b = bundle({
      broker_late_entries: [
        { t_ms: OPEN + 150_000, broker: '후발증권', side: 'sell', net: -5 },
      ],
    });

    const markers = projectBrokerLateEntryMarkers(b, axis, {
      auctionWindowMask: false,
      outlierFilterEnabled: false,
      outlierThreshold: 100,
      sideMode: 'both',
      buyColor: '#ef4444',
      sellColor: '#3b82f6',
    });

    expect(markers).toEqual([
      {
        time: axis.toVirtual(OPEN + 150_000) / 1000,
        price: 2,
        broker: '후발증권',
        label: '후발',
        side: 'sell',
        color: '#3b82f6',
      },
    ]);
  });

  it('skips a marker when its exact ratio bucket is hidden whitespace', () => {
    const axis = createVirtualAxis([
      { date: '20260626', sessionOpenMs: OPEN, sessionCloseMs: CLOSE },
    ]);
    const b = bundle({
      broker_late_entries: [
        { t_ms: OPEN + 60_000, broker: '공백증권', side: 'buy', net: 1 },
      ],
    });

    const markers = projectBrokerLateEntryMarkers(b, axis, {
      auctionWindowMask: false,
      outlierFilterEnabled: false,
      outlierThreshold: 100,
      sideMode: 'both',
      buyColor: '#ef4444',
      sellColor: '#3b82f6',
    });

    expect(markers).toEqual([]);
  });

  it('skips auction-hidden events instead of falling back to an earlier point', () => {
    const axis = createVirtualAxis([
      { date: '20260626', sessionOpenMs: OPEN, sessionCloseMs: CLOSE },
    ]);
    const auctionEventMs = CLOSE - 5 * 60_000;
    const b = bundle({
      candles: [
        candle(OPEN),
        candle(OPEN + 60_000),
        candle(auctionEventMs),
      ],
      quote_ratio: {
        bucket_ms: 60_000,
        points: [
          ratioPoint(OPEN, 200, 100),
          ratioPoint(auctionEventMs, 100, 1000),
        ],
      },
      broker_late_entries: [
        { t_ms: auctionEventMs, broker: '종가증권', side: 'sell', net: -3 },
      ],
    });

    const markers = projectBrokerLateEntryMarkers(b, axis, {
      auctionWindowMask: true,
      outlierFilterEnabled: false,
      outlierThreshold: 100,
      sideMode: 'both',
      buyColor: '#ef4444',
      sellColor: '#3b82f6',
    });

    expect(markers).toEqual([]);
  });

  it('applies the ratio outlier clamp to marker y-values', () => {
    const axis = createVirtualAxis([
      { date: '20260626', sessionOpenMs: OPEN, sessionCloseMs: CLOSE },
    ]);
    const b = bundle({
      quote_ratio: {
        bucket_ms: 60_000,
        points: [ratioPoint(OPEN, 100, 10_000)],
      },
      broker_late_entries: [
        { t_ms: OPEN, broker: '극단증권', side: 'sell', net: -1 },
      ],
    });

    const markers = projectBrokerLateEntryMarkers(b, axis, {
      auctionWindowMask: false,
      outlierFilterEnabled: true,
      outlierThreshold: 100,
      sideMode: 'both',
      buyColor: '#ef4444',
      sellColor: '#3b82f6',
    });

    expect(markers).toEqual([
      expect.objectContaining({
        broker: '극단증권',
        price: 0,
      }),
    ]);
  });

  it('does not fall back across a session boundary', () => {
    const axis = createVirtualAxis([
      { date: '20260626', sessionOpenMs: OPEN, sessionCloseMs: CLOSE },
      { date: '20260627', sessionOpenMs: DAY2_OPEN, sessionCloseMs: DAY2_CLOSE },
    ]);
    const b = bundle({
      from_date: '20260626',
      to_date: '20260627',
      segments: [
        { date: '20260626', session_open_ms: OPEN, session_close_ms: CLOSE },
        { date: '20260627', session_open_ms: DAY2_OPEN, session_close_ms: DAY2_CLOSE },
      ],
      candles: [
        candle(OPEN),
        candle(DAY2_OPEN),
      ],
      quote_ratio: {
        bucket_ms: 60_000,
        points: [ratioPoint(OPEN, 200, 100)],
      },
      broker_late_entries: [
        { t_ms: DAY2_OPEN + 30_000, broker: '이월증권', side: 'buy', net: 2 },
      ],
    });

    const markers = projectBrokerLateEntryMarkers(b, axis, {
      auctionWindowMask: false,
      outlierFilterEnabled: false,
      outlierThreshold: 100,
      sideMode: 'both',
      buyColor: '#ef4444',
      sellColor: '#3b82f6',
    });

    expect(markers).toEqual([]);
  });
});

describe('layoutBrokerLateEntryLabels', () => {
  it('groups a local collision cluster into one compact label', () => {
    const markers = [
      { time: 10, price: 100, broker: '삼성증권', label: '삼성', side: 'buy' as const, color: '#ef4444' },
      { time: 12, price: 100, broker: '키움증권', label: '키움', side: 'buy' as const, color: '#ef4444' },
      { time: 14, price: 100, broker: '미래에셋증권', label: '미래', side: 'buy' as const, color: '#ef4444' },
    ];

    const layout = layoutBrokerLateEntryLabels(markers, {
      minHorizontalGapPx: 4,
      estimateLabelWidthPx: () => 30,
    });

    expect(layout.groups).toEqual([
      {
        markers,
        label: '삼성 +2',
        side: 'buy',
        color: '#ef4444',
      },
    ]);
  });

  it('keeps separate labels when forced full and uses a neutral chip for mixed-side compact groups', () => {
    const markers = [
      { time: 10, price: 100, broker: '삼성증권', label: '삼성', side: 'buy' as const, color: '#ef4444' },
      { time: 12, price: 100, broker: '키움증권', label: '키움', side: 'sell' as const, color: '#3b82f6' },
    ];

    expect(layoutBrokerLateEntryLabels(markers, {
      minHorizontalGapPx: 4,
      estimateLabelWidthPx: () => 30,
      forceFull: true,
    }).groups).toEqual([
      { markers: [markers[0]], label: '삼성', side: 'buy', color: '#ef4444' },
      { markers: [markers[1]], label: '키움', side: 'sell', color: '#3b82f6' },
    ]);

    expect(layoutBrokerLateEntryLabels(markers, {
      minHorizontalGapPx: 4,
      estimateLabelWidthPx: () => 30,
    }).groups).toEqual([
      {
        markers,
        label: '삼성 +1',
        side: 'mixed',
        color: 'var(--fg-dim)',
      },
    ]);
  });
});
