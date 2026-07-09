import { describe, it, expect } from 'vitest';
import { buildLegendRows, readSeriesValue, type PaneCellInput } from './legendRows';
import type { LiveMAConfig } from '../state/livePage';

const ma = (over: Partial<LiveMAConfig> & { id: string }): LiveMAConfig => ({
  enabled: true,
  period: 5,
  color: '#EC4899',
  lineWidth: 1,
  source: 'close',
  ...over,
});

const base = {
  movingAverages: [] as LiveMAConfig[],
  movingAverageEnabled: true,
  movingAverageHidden: false,
  maValues: new Map<string, number>(),
  paneCells: [] as PaneCellInput[],
};

describe('buildLegendRows — candle MA row', () => {
  it('builds candle MA rows from enabled slots; value=null when missing', () => {
    const rows = buildLegendRows({
      ...base,
      movingAverages: [ma({ id: 'ma-1', period: 5 }), ma({ id: 'ma-2', period: 20 })],
      maValues: new Map([['ma-1', 311400]]), // ma-2 absent → null
    });
    const candle = rows.find((r) => r.paneId === 'candle');
    expect(candle?.kind === 'ma' && candle.mas[0].value).toBe(311400);
    expect(candle?.kind === 'ma' && candle.mas[1].value).toBeNull();
    expect(candle?.kind === 'ma' && candle.hidden).toBe(false);
  });

  it('omits disabled MA slots from the candle row', () => {
    const rows = buildLegendRows({
      ...base,
      movingAverages: [ma({ id: 'ma-1' }), ma({ id: 'ma-2', enabled: false })],
      maValues: new Map([['ma-1', 1], ['ma-2', 2]]),
    });
    const candle = rows.find((r) => r.paneId === 'candle');
    expect(candle?.kind === 'ma' && candle.mas).toHaveLength(1);
    expect(candle?.kind === 'ma' && candle.mas[0].id).toBe('ma-1');
  });

  it('omits the candle row entirely when the MA master is off', () => {
    const rows = buildLegendRows({
      ...base,
      movingAverages: [ma({ id: 'ma-1' })],
      movingAverageEnabled: false, // master off → MovingAverageOverlay clears data
      maValues: new Map([['ma-1', 999]]),
    });
    expect(rows.find((r) => r.paneId === 'candle')).toBeUndefined();
  });
});

describe('buildLegendRows — generic pane cell rows', () => {
  it('builds a multi-cell row and formats values (default 천단위 구분)', () => {
    const rows = buildLegendRows({
      ...base,
      paneCells: [
        {
          paneId: 'quote-totals',
          title: '총잔량',
          toggleKey: 'quoteTotalsEnabled',
          cells: [
            { key: 'a', label: '매수', color: '#F04452', value: 311400 },
            { key: 'b', label: '매도', color: '#3485FA', value: 6789 },
          ],
        },
      ],
    });
    const row = rows.find((r) => r.paneId === 'quote-totals');
    expect(row?.kind).toBe('cells');
    expect(row?.kind === 'cells' && row.title).toBe('총잔량');
    expect(row?.kind === 'cells' && row.toggleKey).toBe('quoteTotalsEnabled');
    expect(row?.kind === 'cells' && row.cells.map((c) => c.formatted)).toEqual([
      '311,400',
      '6,789',
    ]);
    expect(row?.kind === 'cells' && row.cells.map((c) => c.label)).toEqual(['매수', '매도']);
    expect(row?.kind === 'cells' && row.cells[0].color).toBe('#F04452');
  });

  it('drops null-valued cells (toggle off / cold load) but keeps the rest', () => {
    const rows = buildLegendRows({
      ...base,
      paneCells: [
        {
          paneId: 'fill-strength',
          title: '체결강도',
          cells: [
            { key: 'buy', label: '매수', value: 10 },
            { key: 'sell', label: '매도', value: 20 },
            { key: 'cum', label: '누적', value: null }, // cumulative off → omitted
          ],
        },
      ],
    });
    const row = rows.find((r) => r.paneId === 'fill-strength');
    expect(row?.kind === 'cells' && row.cells.map((c) => c.label)).toEqual(['매수', '매도']);
  });

  it('emits no row when every cell is null (pane mounted but empty)', () => {
    const rows = buildLegendRows({
      ...base,
      paneCells: [
        {
          paneId: 'volume',
          cells: [{ key: 'v', label: '거래량', value: null }],
        },
      ],
    });
    expect(rows.some((r) => r.paneId === 'volume')).toBe(false);
  });

  it('applies a per-cell formatter when provided', () => {
    const rows = buildLegendRows({
      ...base,
      paneCells: [
        {
          paneId: 'program-trade',
          cells: [{ key: 'p', label: '프로그램 순매수', value: 5, format: (v) => `${v}억` }],
        },
      ],
    });
    const row = rows.find((r) => r.paneId === 'program-trade');
    expect(row?.kind === 'cells' && row.cells[0].formatted).toBe('5억');
  });
});

describe('readSeriesValue', () => {
  const makeSeries = (data: unknown[]) => ({ data: () => data }) as never;

  it('reads the value at the cursor from seriesData when present', () => {
    const s = makeSeries([{ time: 1, value: 10 }, { time: 2, value: 20 }]);
    const seriesData = new Map([[s, { time: 2, value: 20 }]]);
    expect(readSeriesValue(s, seriesData)).toBe(20);
  });

  it('falls back to the latest data point when the cursor is absent', () => {
    const s = makeSeries([{ time: 1, value: 10 }, { time: 2, value: 22 }]);
    expect(readSeriesValue(s, null)).toBe(22);
  });

  it('falls back to latest when the series is not in the seriesData map', () => {
    const s = makeSeries([{ time: 1, value: 7 }]);
    expect(readSeriesValue(s, new Map())).toBe(7);
  });

  it('returns null for a whitespace last point, empty data, or undefined series', () => {
    expect(readSeriesValue(makeSeries([{ time: 1 }]), null)).toBeNull();
    expect(readSeriesValue(makeSeries([]), null)).toBeNull();
    expect(readSeriesValue(undefined, null)).toBeNull();
  });
});
