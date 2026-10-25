import { expect, it } from 'vitest';
import type { Candle } from '../../api/types';
import { captureSecondTimeframeViewport, registerSecondTimeframeViewport, restoreSecondTimeframeViewport, type SecondTimeframeViewport } from './secondTimeframeViewport';

const at = Date.parse('2026-10-23T09:00:00+09:00');
const candles = (times: number[]) => times.map(ts_ms => ({ ts_ms } as Candle));
const transfer = (overrides: Partial<SecondTimeframeViewport['viewport']> = {}): SecondTimeframeViewport => ({
  code: '005930', timeframe: '5s', target: '10s', venue: 'KRX', followLatest: overrides.atLiveEdge ?? false,
  viewport: { leftEdgeMs: at + 100000, rightEdgeMs: at + 200000, barSpan: 20, atLiveEdge: false, ...overrides },
});

it('preserves both real edges instead of the previous timeframe bar count', () => {
  const data = candles(Array.from({ length: 30 }, (_, i) => at + i * 10000));
  expect(restoreSecondTimeframeViewport(transfer(), data)).toMatchObject({ rightEdgeMs: at + 200000, barSpan: 10, userAdjusted: true });
});

it('does not grow the zoom when the visible range includes a partial left candle', () => {
  const data = candles(Array.from({ length: 30 }, (_, i) => at + i * 10000));
  expect(restoreSecondTimeframeViewport(transfer({ leftEdgeMs: at + 95000, rightEdgeMs: at + 250000, barSpan: 30 }), data))
    .toMatchObject({ rightEdgeMs: at + 250000, barSpan: 15 });
});

it('uses observed indices across nights and gaps without inventing candles', () => {
  const data = candles([at, at + 100000, at + 86400000, at + 86500000]);
  const source = transfer({ leftEdgeMs: at + 100000, rightEdgeMs: at + 86500000 });
  expect(restoreSecondTimeframeViewport(source, data)).toMatchObject({ rightEdgeMs: at + 86500000, barSpan: 2 });
  expect(restoreSecondTimeframeViewport(source, [])).toBeNull();
});

it('keeps following latest observations and rescales explicit right whitespace', () => {
  const data = candles(Array.from({ length: 30 }, (_, i) => at + i * 10000));
  expect(restoreSecondTimeframeViewport(transfer({ atLiveEdge: true, rightPaddingBars: 4 }), data))
    .toMatchObject({ rightEdgeMs: at + 290000, barSpan: 21.5, rightPaddingBars: 1.5, atLiveEdge: true });
});

it('preserves right whitespace at a bounded historical edge without following live', () => {
  const source: SecondTimeframeViewport = { ...transfer(), timeframe: '1s', target: '5s', followLatest: false,
    viewport: { leftEdgeMs: at + 140000, rightEdgeMs: at + 240000, barSpan: 120, atLiveEdge: true, rightPaddingBars: 19 } };
  expect(restoreSecondTimeframeViewport(source, candles(Array.from({ length: 49 }, (_, i) => at + i * 5000))))
    .toMatchObject({ rightEdgeMs: at + 240000, barSpan: 24, atLiveEdge: true, rightPaddingBars: 3 });
});

it('isolates registrations by window and old unmounts cannot remove a new capture', () => {
  const first = registerSecondTimeframeViewport('a', () => transfer());
  const second = registerSecondTimeframeViewport('a', () => transfer({ rightEdgeMs: at + 300000 }));
  first();
  expect(captureSecondTimeframeViewport('a', '30s', '005930')).toMatchObject({ target: '30s', viewport: { rightEdgeMs: at + 300000 } });
  expect(captureSecondTimeframeViewport('a', '30s', '000660')).toBeNull();
  expect(captureSecondTimeframeViewport('b', '1s', '005930')).toBeNull();
  second();
  expect(captureSecondTimeframeViewport('a', '1s', '005930')).toBeNull();
});
