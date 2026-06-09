import { describe, it, expect } from 'vitest';
import { projectCandle } from './candle';
import { createVirtualAxis } from '../../util/virtualAxis';

// 레거시 3-콜 경로를 재현한 레퍼런스 projector (측정 비교 기준).
function projectCandleLegacy(bundle: any, axis: any) {
  return bundle.candles
    .filter((c: any) => axis.contains(c.ts_ms))
    .map((c: any) => {
      const inAuction = axis.inClosingAuctionWindow(c.ts_ms);
      return { time: axis.toVirtual(c.ts_ms) / 1000, open: c.open, close: c.close, high: c.high, low: c.low, inAuction };
    });
}

describe('projectCandle deep-scroll wall-clock', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const FULL = 6.5 * 60 * 60 * 1000;
  const base = 1_779_062_400_000;
  const segments = [];
  for (let d = 0; d < 170; d++) {
    const open = base + d * DAY;
    segments.push({ date: `2026d${d}`, sessionOpenMs: open, sessionCloseMs: open + FULL });
  }
  const axis = createVirtualAxis(segments);

  // ~65k 캔들: 170일 × 390분봉.
  const candles = [];
  for (let d = 0; d < 170; d++) {
    const open = base + d * DAY;
    for (let m = 0; m < 390; m++) {
      const ts = open + m * 60_000;
      candles.push({ ts_ms: ts, open: 100, close: 101, high: 102, low: 99 });
    }
  }
  const bundle: any = { candles };

  function median(fn: () => void): number {
    const runs: number[] = [];
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now();
      fn();
      runs.push(performance.now() - t0);
    }
    return runs.sort((a, b) => a - b)[3];
  }

  it('single-pass projector is faster than the legacy three-call path', () => {
    projectCandle(bundle, axis); // warm-up
    projectCandleLegacy(bundle, axis);
    const fused = median(() => projectCandle(bundle, axis));
    const legacy = median(() => projectCandleLegacy(bundle, axis));
    // eslint-disable-next-line no-console
    console.log(`[perf] candles=${candles.length} segments=${segments.length} fused=${fused.toFixed(1)}ms legacy=${legacy.toFixed(1)}ms`);
    expect(fused).toBeLessThanOrEqual(legacy);
  });
});
