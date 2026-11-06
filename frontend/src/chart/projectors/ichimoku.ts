export const ICHIMOKU_LINES = ['conversion', 'base', 'leadingA', 'leadingB', 'lagging'] as const;
export type IchimokuLine = typeof ICHIMOKU_LINES[number];
export type IchimokuPeriods = Readonly<{ conversion: number; base: number; leadingB: number; displacement: number }>;
export type IchimokuBar = Readonly<{ virtualSecond: number; high: number; low: number; close: number; breakBefore: boolean }>;
export type IchimokuProjection = Readonly<{
  bars: readonly IchimokuBar[];
  lines: Readonly<Record<IchimokuLine, Readonly<{ offset: number; values: readonly (number | null)[] }>>>;
}>;

function midpoints(bars: readonly IchimokuBar[], period: number): (number | null)[] {
  const values: (number | null)[] = bars.map(() => null);
  const highs: number[] = [], lows: number[] = [];
  let highHead = 0, lowHead = 0, invalidAt = -1;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!Number.isFinite(bar.high) || !Number.isFinite(bar.low) || bar.high < bar.low) { invalidAt = i; continue; }
    while (highs.length > highHead && bars[highs.at(-1)!].high <= bar.high) highs.pop();
    while (lows.length > lowHead && bars[lows.at(-1)!].low >= bar.low) lows.pop();
    highs.push(i); lows.push(i);
    while (highHead < highs.length && highs[highHead] <= i - period) highHead++;
    while (lowHead < lows.length && lows[lowHead] <= i - period) lowHead++;
    if (i >= period - 1 && invalidAt <= i - period) values[i] = bars[highs[highHead]].high / 2 + bars[lows[lowHead]].low / 2;
  }
  return values;
}

export function projectIchimoku(bars: readonly IchimokuBar[], periods: IchimokuPeriods): IchimokuProjection {
  const conversion = midpoints(bars, periods.conversion), base = midpoints(bars, periods.base);
  return { bars, lines: {
    conversion: { offset: 0, values: conversion }, base: { offset: 0, values: base },
    leadingA: { offset: periods.displacement, values: conversion.map((value, i) => value === null || base[i] === null ? null : value / 2 + base[i]! / 2) },
    leadingB: { offset: periods.displacement, values: midpoints(bars, periods.leadingB) },
    lagging: { offset: -periods.displacement, values: bars.map(bar => Number.isFinite(bar.close) ? bar.close : null) },
  } };
}

export function valuesAtDisplayBar(model: IchimokuProjection, display: number): Readonly<Record<IchimokuLine, number | null>> {
  const at = (line: IchimokuLine) => display < 0 || !Number.isInteger(display) ? null : model.lines[line].values[display - model.lines[line].offset] ?? null;
  return { conversion: at('conversion'), base: at('base'), leadingA: at('leadingA'), leadingB: at('leadingB'), lagging: at('lagging') };
}

export function ichimokuConnected(model: IchimokuProjection, source: number, offset: number): boolean {
  if (source <= 0 || model.bars[source].breakBefore) return false;
  const target = source + offset;
  return target > 0 && (target >= model.bars.length || !model.bars[target].breakBefore);
}
