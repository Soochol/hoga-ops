import { describe, it, expect } from 'vitest';
import { buildCandleTooltip, formatTooltipQtyK } from './candleTooltipModel';
import type { Candle } from '../api/types';

// ts_ms 는 실 Unix ms (ADR-0003). 09:00 KST = baseMs.
const baseMs = 1779840000000;
const C = (
  tsMs: number, o: number, h: number, l: number, c: number, va: number, vb = 0,
): Candle => ({ ts_ms: tsMs, open: o, high: h, low: l, close: c, vol_a: va, vol_b: vb });

const bars: Candle[] = [
  C(baseMs + 0 * 60_000, 100, 105, 99, 102, 10),
  C(baseMs + 1 * 60_000, 102, 108, 101, 107, 20),
  C(baseMs + 2 * 60_000, 107, 110, 104, 105, 20), // 거래량 동일 → 100%
];

describe('buildCandleTooltip', () => {
  it('index 범위 밖이면 null', () => {
    expect(buildCandleTooltip(bars, -1, '1m')).toBeNull();
    expect(buildCandleTooltip(bars, 3, '1m')).toBeNull();
  });

  it('index 0 (직전 봉 없음) → OHLC %·직전대비·거래량비 null, OHLC·거래량은 채움', () => {
    const m = buildCandleTooltip(bars, 0, '1m')!;
    expect(m.open).toBe(100);
    expect(m.close).toBe(102);
    expect(m.volume).toBe(10);
    expect(m.openPct).toBeNull();
    expect(m.highPct).toBeNull();
    expect(m.lowPct).toBeNull();
    expect(m.closePct).toBeNull();
    expect(m.barOverBarWon).toBeNull();
    expect(m.volumeRatioPct).toBeNull();
  });

  it('상승봉: OHLC 각 %·직전대비 금액 = 직전 봉 종가(102) 대비', () => {
    const m = buildCandleTooltip(bars, 1, '1m')!;
    expect(m.openPct).toBeCloseTo(0, 6);                 // 102/102
    expect(m.highPct).toBeCloseTo((108 / 102 - 1) * 100, 6);
    expect(m.lowPct).toBeCloseTo((101 / 102 - 1) * 100, 6);
    expect(m.closePct).toBeCloseTo((107 / 102 - 1) * 100, 6);
    expect(m.barOverBarWon).toBe(5);                     // 107 - 102 (직전대비 금액)
    expect(m.volume).toBe(20);
    expect(m.volumeRatioPct).toBe(200);                  // 20 / 10 * 100
  });

  it('거래량 동일 → 거래량비 100%', () => {
    const m = buildCandleTooltip(bars, 2, '1m')!;
    expect(m.volumeRatioPct).toBe(100);          // 20 / 20 * 100
  });

  it('prevVolume===0 → 거래량비 null (0 나눗셈 회피)', () => {
    const zeroPrev = [C(baseMs, 100, 100, 100, 100, 0), C(baseMs + 60_000, 100, 101, 99, 100, 5)];
    expect(buildCandleTooltip(zeroPrev, 1, '1m')!.volumeRatioPct).toBeNull();
  });

  it('prev.close===0 → OHLC %·직전대비 null (Infinity 방지, 0 나눗셈 회피)', () => {
    const zeroClose = [C(baseMs, 0, 0, 0, 0, 5), C(baseMs + 60_000, 100, 110, 90, 105, 8)];
    const m = buildCandleTooltip(zeroClose, 1, '1m')!;
    expect(m.barOverBarWon).toBeNull();
    expect(m.openPct).toBeNull();
    expect(m.highPct).toBeNull();
    expect(m.lowPct).toBeNull();
    expect(m.closePct).toBeNull();        // (105/0-1)*100 = Infinity 가 아니라 null
  });

  it('분봉: dateLabel MM/DD + timeLabel HH:MM (KST)', () => {
    const m = buildCandleTooltip(bars, 1, '1m')!;
    expect(m.dateLabel).toBe('05/27');           // baseMs+1m 의 KST 날짜
    expect(m.timeLabel).toBe('09:01');
  });

  it('D/W/M: timeLabel null, dateLabel YYYY/MM/DD', () => {
    const m = buildCandleTooltip(bars, 1, 'D')!;
    expect(m.timeLabel).toBeNull();
    expect(m.dateLabel).toBe('2026/05/27');
  });

  it('vol_a + vol_b 합을 거래량으로', () => {
    const split = [C(baseMs, 1, 1, 1, 1, 3, 4)];
    expect(buildCandleTooltip(split, 0, '1m')!.volume).toBe(7);
  });

  it('호가 총잔량과 ask/bid ratio 를 툴팁 모델에 포함한다', () => {
    const m = buildCandleTooltip(bars, 1, '1m', {
      t: bars[1].ts_ms,
      ask_total: 32_500,
      bid_total: 900,
      ask_max: 32_500,
      bid_max: 900,
      imb_max_ask: 32_500,
      imb_max_bid: 900,
    })!;
    expect(m.quoteAskTotal).toBe(32_500);
    expect(m.quoteBidTotal).toBe(900);
    expect(m.askBidRatio).toBeCloseTo(36.111, 3);
    expect(m.askBidBiasLabel).toBe('매도우위');
  });

  it('매수 총잔량이 0이면 ask/bid ratio 는 null 로 둔다', () => {
    const m = buildCandleTooltip(bars, 1, '1m', {
      t: bars[1].ts_ms,
      ask_total: 32_500,
      bid_total: 0,
      ask_max: 32_500,
      bid_max: 0,
      imb_max_ask: 32_500,
      imb_max_bid: 0,
    })!;
    expect(m.askBidRatio).toBeNull();
    expect(m.askBidBiasLabel).toBeNull();
  });
});

describe('formatTooltipQtyK', () => {
  it('항상 k 단위 소수 1자리로 표시한다', () => {
    expect(formatTooltipQtyK(32_500)).toBe('32.5k');
    expect(formatTooltipQtyK(900)).toBe('0.9k');
    expect(formatTooltipQtyK(257_000)).toBe('257.0k');
  });
});

import { placeTooltip } from './candleTooltipModel';

describe('placeTooltip', () => {
  // 컨테이너 800×400, 툴팁 160×130, margin 12
  it('여유 있으면 커서 우하단(+14,+12)', () => {
    expect(placeTooltip(100, 50, 800, 400, 160, 130)).toEqual({ left: 114, top: 62 });
  });

  it('오른쪽 넘치면 커서 왼쪽으로 flip', () => {
    const p = placeTooltip(760, 50, 800, 400, 160, 130);
    expect(p.left).toBe(760 - 14 - 160); // 586
  });

  it('아래 넘치면 커서 위로 flip', () => {
    const p = placeTooltip(100, 380, 800, 400, 160, 130);
    expect(p.top).toBe(380 - 12 - 130); // 238
  });

  it('항상 컨테이너 안으로 clamp', () => {
    const p = placeTooltip(5, 5, 800, 400, 160, 130);
    expect(p.left).toBeGreaterThanOrEqual(12);
    expect(p.top).toBeGreaterThanOrEqual(12);
  });
});
