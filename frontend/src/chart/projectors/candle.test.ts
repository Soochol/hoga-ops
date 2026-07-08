import { describe, it, expect, vi } from 'vitest';
import { CANDLE_SPEC, projectCandle } from './candle';
import { createVirtualAxis } from '../../util/virtualAxis';

const sessionOpenMs = 1_779_062_400_000;
const axis = createVirtualAxis([
  { date: '20260518', sessionOpenMs, sessionCloseMs: sessionOpenMs + 23_400_000 },
]);

describe('projectCandle', () => {
  it('maps OHLC and assigns up color to up candles, down color to down candles', () => {
    const bundle: any = {
      candles: [
        { ts_ms: sessionOpenMs, open: 100, close: 110, high: 115, low: 95, vol_a: 0, vol_b: 0 },
        { ts_ms: sessionOpenMs + 1000, open: 110, close: 105, high: 112, low: 100, vol_a: 0, vol_b: 0 },
      ],
    };
    const data = projectCandle(bundle, axis);
    expect(data).toHaveLength(2);
    expect(data[0].time).toBe(0);
    expect(data[0].open).toBe(100);
    expect(data[0].close).toBe(110);
    expect(data[0].high).toBe(115);
    expect(data[0].low).toBe(95);
    // up vs down differ
    expect(data[0].color).not.toBe(data[1].color);
    expect(data[0].borderColor).toBe(data[0].color);
    expect(data[0].wickColor).toBe(data[0].color);
  });

  it('applies muted color to candles inside the closing Auction Window (15:20-15:30 KST)', () => {
    // sessionOpenMs = 09:00 KST. 15:20 KST = sessionOpenMs + 6h20m = sessionOpenMs + 22_800_000.
    const auctionStartMs = sessionOpenMs + 22_800_000;
    const bundle: any = {
      candles: [
        { ts_ms: sessionOpenMs + 60_000, open: 100, close: 110, high: 115, low: 95, vol_a: 0, vol_b: 0 },
        { ts_ms: auctionStartMs + 60_000, open: 110, close: 115, high: 116, low: 109, vol_a: 0, vol_b: 0 },
      ],
    };
    const data = projectCandle(bundle, axis);
    expect(data[0].color).not.toBe(data[1].color); // first up colored, second muted
    // muted color is the same regardless of close>=open
    const sameSlot: any = {
      candles: [
        { ts_ms: auctionStartMs + 60_000, open: 110, close: 105, high: 116, low: 100, vol_a: 0, vol_b: 0 },
      ],
    };
    expect(projectCandle(sameSlot, axis)[0].color).toBe(data[1].color);
  });

  it('keeps normal up/down candle colors when auction muting is disabled', () => {
    const auctionStartMs = sessionOpenMs + 22_800_000;
    const bundle: any = {
      candles: [
        { ts_ms: sessionOpenMs + 60_000, open: 100, close: 110, high: 115, low: 95, vol_a: 0, vol_b: 0 },
        { ts_ms: auctionStartMs + 60_000, open: 110, close: 115, high: 116, low: 109, vol_a: 0, vol_b: 0 },
        { ts_ms: auctionStartMs + 120_000, open: 115, close: 105, high: 116, low: 100, vol_a: 0, vol_b: 0 },
      ],
    };

    const normal = projectCandle(bundle, axis, { muteAuctionCandles: false });

    expect(normal[1].color).toBe(normal[0].color);
    expect(normal[2].color).not.toBe(normal[0].color);
  });

  it('drops candles outside the segment via axis.contains', () => {
    const bundle: any = {
      candles: [
        { ts_ms: sessionOpenMs - 60_000, open: 100, close: 100, high: 100, low: 100, vol_a: 0, vol_b: 0 },
        { ts_ms: sessionOpenMs, open: 100, close: 110, high: 115, low: 95, vol_a: 0, vol_b: 0 },
      ],
    };
    expect(projectCandle(bundle, axis)).toHaveLength(1);
    expect(projectCandle(bundle, axis)[0].open).toBe(100);
  });

  it('cached spec data reprojects only today after a live tick', () => {
    const day0Open = sessionOpenMs;
    const day1Open = sessionOpenMs + 24 * 60 * 60 * 1000;
    const past0 = { ts_ms: day0Open, open: 100, close: 101, high: 102, low: 99, vol_a: 1, vol_b: 0 };
    const past1 = { ts_ms: day0Open + 60_000, open: 101, close: 102, high: 103, low: 100, vol_a: 1, vol_b: 0 };
    const today = { ts_ms: day1Open, open: 102, close: 103, high: 104, low: 101, vol_a: 1, vol_b: 0 };
    const segments = [
      { date: '20260518', session_open_ms: day0Open, session_close_ms: day0Open + 23_400_000, source: 'kis_live' },
      { date: '20260519', session_open_ms: day1Open, session_close_ms: day1Open + 23_400_000, source: 'kis_live' },
    ];
    const calls: number[] = [];
    const countingAxis = {
      classifyAndProject: (t: number) => {
        calls.push(t);
        return { contained: true, inAuction: false, virtual: t - day0Open };
      },
    } as never;
    const dataFn = CANDLE_SPEC.series[0].data as (...args: any[]) => Array<{ close: number }>;

    dataFn({ segments, candles: [past0, past1, today] } as never, countingAxis);
    calls.length = 0;
    const data = dataFn(
      { segments, candles: [past0, past1, { ...today, close: 104, high: 105 }] } as never,
      countingAxis,
    );

    expect(calls).toEqual([today.ts_ms]);
    expect(data.at(-1)?.close).toBe(104);
  });

  it('reprojects cached past candles when the theme changes (color re-resolves)', () => {
    const day0Open = sessionOpenMs;
    const day1Open = sessionOpenMs + 24 * 60 * 60 * 1000;
    // past0 is an up candle (close ≥ open) → its color = --price-up.
    const past0 = { ts_ms: day0Open, open: 100, close: 101, high: 102, low: 99, vol_a: 1, vol_b: 0 };
    const past1 = { ts_ms: day0Open + 60_000, open: 101, close: 102, high: 103, low: 100, vol_a: 1, vol_b: 0 };
    const today = { ts_ms: day1Open, open: 102, close: 103, high: 104, low: 101, vol_a: 1, vol_b: 0 };
    const segments = [
      { date: '20260518', session_open_ms: day0Open, session_close_ms: day0Open + 23_400_000, source: 'kis_live' },
      { date: '20260519', session_open_ms: day1Open, session_close_ms: day1Open + 23_400_000, source: 'kis_live' },
    ];
    // Fresh theme names ('thm-*') keep the module-level themed-token cache empty
    // for these keys, so the stub — not another test's cached fallbacks — drives
    // the colors. --price-up differs per theme; the rest are constant.
    const stub = vi.spyOn(window, 'getComputedStyle').mockImplementation(
      () =>
        ({
          getPropertyValue: (v: string) => {
            const theme = document.documentElement.getAttribute('data-theme');
            if (v === '--price-up') return theme === 'thm-b' ? '#AAAAAA' : '#F04452';
            if (v === '--price-down') return '#3485FA';
            if (v === '--fg-dim') return '#9A9AA8';
            return '';
          },
        }) as unknown as CSSStyleDeclaration,
    );
    const axisObj = {
      classifyAndProject: (t: number) => ({ contained: true, inAuction: false, virtual: t - day0Open }),
    } as never;
    const dataFn = CANDLE_SPEC.series[0].data as (...args: any[]) => Array<{ color?: string }>;
    const bundle = { segments, candles: [past0, past1, today] } as never;

    document.documentElement.setAttribute('data-theme', 'thm-a');
    const first = dataFn(bundle, axisObj);
    const pastColorA = first[0].color;

    // Same axis + byte-identical candle data → without the cache theme key the
    // frozen past slice would return thm-a's color.
    document.documentElement.setAttribute('data-theme', 'thm-b');
    const second = dataFn(bundle, axisObj);
    const pastColorB = second[0].color;

    expect(pastColorA).toBe('#F04452');
    expect(pastColorB).toBe('#AAAAAA');
    expect(pastColorB).not.toBe(pastColorA);

    stub.mockRestore();
    document.documentElement.removeAttribute('data-theme');
  });
});
