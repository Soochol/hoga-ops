import { describe, expect, it } from 'vitest';
import type { BrokerSeriesEntry, OrderbookSnapshot } from '../api/types';
import {
  resolveBrokerCardProps,
  resolveCursorDetailScope,
  resolveOrderbookCardSnapshot,
} from './cursorDetailResolver';

const snapshot: OrderbookSnapshot = {
  ts_ms: 1_000,
  seq: 1,
  ask: Array.from({ length: 10 }, (_, index) => ({ price: 70_100 + index, qty: 10 + index })),
  bid: Array.from({ length: 10 }, (_, index) => ({ price: 70_000 - index, qty: 20 + index })),
  tot_ask: 145,
  tot_bid: 245,
};

const brokers: BrokerSeriesEntry[] = [
  {
    broker: '키움증권',
    final_net: 1_200,
    dominant_side: 'buy',
    points: [{ ts_ms: 1_000, net: 1_200 }],
  },
];

describe('cursorDetailResolver', () => {
  it('enters cursor scope only when cursorMs and minute timeframe are both present', () => {
    expect(resolveCursorDetailScope({ cursorMs: 1_000, timeframe: '5m' })).toEqual({
      kind: 'minute-cursor',
      cursorMs: 1_000,
      minuteTimeframe: '5m',
    });
    expect(resolveCursorDetailScope({ cursorMs: null, timeframe: '5m' })).toEqual({
      kind: 'inactive',
      cursorMs: null,
      minuteTimeframe: null,
    });
    expect(resolveCursorDetailScope({ cursorMs: 1_000, timeframe: 'D' })).toEqual({
      kind: 'inactive',
      cursorMs: null,
      minuteTimeframe: null,
    });
  });

  it('preserves loading versus no-data for cursor orderbook scope', () => {
    const scope = resolveCursorDetailScope({ cursorMs: 1_000, timeframe: '5m' });

    expect(resolveOrderbookCardSnapshot({
      scope,
      spotSnapshot: undefined,
      inactiveSnapshot: null,
      bufferFallbackSnapshot: null,
    })).toBeUndefined();

    expect(resolveOrderbookCardSnapshot({
      scope,
      spotSnapshot: null,
      inactiveSnapshot: null,
      bufferFallbackSnapshot: null,
    })).toBeNull();

    expect(resolveOrderbookCardSnapshot({
      scope,
      spotSnapshot: snapshot,
      inactiveSnapshot: null,
      bufferFallbackSnapshot: null,
    })).toBe(snapshot);
  });

  it('uses inactive orderbook only while inactive', () => {
    const scope = resolveCursorDetailScope({ cursorMs: null, timeframe: '5m' });

    expect(resolveOrderbookCardSnapshot({
      scope,
      spotSnapshot: undefined,
      inactiveSnapshot: snapshot,
      bufferFallbackSnapshot: null,
    })).toBe(snapshot);
  });

  it('keeps calendar timeframe cursor out of cursor detail mode', () => {
    const scope = resolveCursorDetailScope({ cursorMs: 1_000, timeframe: 'D' });

    expect(resolveOrderbookCardSnapshot({
      scope,
      spotSnapshot: undefined,
      inactiveSnapshot: snapshot,
      bufferFallbackSnapshot: null,
    })).toBe(snapshot);
  });

  it('uses live buffer fallback only when cursor spot explicitly returned null', () => {
    const scope = resolveCursorDetailScope({ cursorMs: 1_000, timeframe: '5m' });

    expect(resolveOrderbookCardSnapshot({
      scope,
      spotSnapshot: null,
      inactiveSnapshot: null,
      bufferFallbackSnapshot: snapshot,
    })).toBe(snapshot);

    expect(resolveOrderbookCardSnapshot({
      scope,
      spotSnapshot: undefined,
      inactiveSnapshot: null,
      bufferFallbackSnapshot: snapshot,
    })).toBeUndefined();
  });

  it('returns cursor broker props in cursor scope and inactive broker props while inactive', () => {
    const cursorScope = resolveCursorDetailScope({ cursorMs: 1_000, timeframe: '5m' });
    expect(resolveBrokerCardProps({
      scope: cursorScope,
      spotSeries: undefined,
      inactiveSeries: [],
      inactiveCursorMs: 9_000,
    })).toEqual({ series: undefined, cursorMs: 1_000 });

    const inactiveScope = resolveCursorDetailScope({ cursorMs: null, timeframe: '5m' });
    expect(resolveBrokerCardProps({
      scope: inactiveScope,
      spotSeries: undefined,
      inactiveSeries: brokers,
      inactiveCursorMs: 9_000,
    })).toEqual({ series: brokers, cursorMs: 9_000 });
  });
});
