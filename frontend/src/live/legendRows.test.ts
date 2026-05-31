import { describe, it, expect } from 'vitest';
import { buildLegendRows, readSeriesValue } from './legendRows';
import type { LiveMAConfig } from '../state/livePage';

const ma = (over: Partial<LiveMAConfig> & { id: string }): LiveMAConfig => ({
  enabled: true,
  period: 5,
  color: '#EC4899',
  lineWidth: 1,
  source: 'close',
  ...over,
});

describe('buildLegendRows', () => {
  it('builds candle MA rows from enabled slots; value=null when missing', () => {
    const rows = buildLegendRows({
      timeframe: 'D',
      movingAverages: [ma({ id: 'ma-1', period: 5 }), ma({ id: 'ma-2', period: 20 })],
      movingAverageEnabled: true,
      movingAverageHidden: false,
      maValues: new Map([['ma-1', 311400]]), // ma-2 absent → null
      volumeEnabled: true,
      volumeValue: 12345,
      foreignNetEnabled: true,
      foreignValue: 100,
      institutionNetEnabled: true,
      institutionValue: -50,
    });
    const candle = rows.find((r) => r.paneId === 'candle');
    expect(candle && candle.paneId === 'candle' && candle.mas[0].value).toBe(311400);
    expect(candle && candle.paneId === 'candle' && candle.mas[1].value).toBeNull();
    expect(candle && candle.paneId === 'candle' && candle.hidden).toBe(false);
  });

  it('omits disabled MA slots from the candle row', () => {
    const rows = buildLegendRows({
      timeframe: 'D',
      movingAverages: [ma({ id: 'ma-1' }), ma({ id: 'ma-2', enabled: false })],
      movingAverageEnabled: true,
      movingAverageHidden: false,
      maValues: new Map([['ma-1', 1], ['ma-2', 2]]),
      volumeEnabled: false,
      volumeValue: null,
      foreignNetEnabled: false,
      foreignValue: null,
      institutionNetEnabled: false,
      institutionValue: null,
    });
    const candle = rows.find((r) => r.paneId === 'candle');
    expect(candle && candle.paneId === 'candle' && candle.mas).toHaveLength(1);
    expect(candle && candle.paneId === 'candle' && candle.mas[0].id).toBe('ma-1');
  });

  it('omits the candle row entirely when the MA master is off', () => {
    const rows = buildLegendRows({
      timeframe: 'D',
      movingAverages: [ma({ id: 'ma-1' })],
      movingAverageEnabled: false, // master off → MovingAverageOverlay clears data
      movingAverageHidden: false,
      maValues: new Map([['ma-1', 999]]),
      volumeEnabled: false,
      volumeValue: null,
      foreignNetEnabled: false,
      foreignValue: null,
      institutionNetEnabled: false,
      institutionValue: null,
    });
    expect(rows.find((r) => r.paneId === 'candle')).toBeUndefined();
  });

  it('emits volume on every timeframe but investor rows only on D', () => {
    const onW = buildLegendRows({
      timeframe: 'W',
      movingAverages: [],
      movingAverageEnabled: true,
      movingAverageHidden: false,
      maValues: new Map(),
      volumeEnabled: true,
      volumeValue: 7,
      foreignNetEnabled: true,
      foreignValue: 100,
      institutionNetEnabled: true,
      institutionValue: -50,
    });
    expect(onW.some((r) => r.paneId === 'volume')).toBe(true);
    expect(onW.some((r) => r.paneId.startsWith('investor'))).toBe(false);
  });

  it('investor rows carry sign-correct values and 량 labels on D', () => {
    const rows = buildLegendRows({
      timeframe: 'D',
      movingAverages: [],
      movingAverageEnabled: true,
      movingAverageHidden: false,
      maValues: new Map(),
      volumeEnabled: false,
      volumeValue: null,
      foreignNetEnabled: true,
      foreignValue: 1061741,
      institutionNetEnabled: true,
      institutionValue: -1061741,
    });
    const f = rows.find((r) => r.paneId === 'investor-foreign');
    const i = rows.find((r) => r.paneId === 'investor-institution');
    expect(f?.value).toBe(1061741);
    expect(f?.label).toBe('외국인 순매수량');
    expect(i?.value).toBe(-1061741);
    expect(i?.label).toBe('기관 순매수량');
  });

  it('drops the foreign row but keeps institution when only institution is on', () => {
    const rows = buildLegendRows({
      timeframe: 'D',
      movingAverages: [],
      movingAverageEnabled: true,
      movingAverageHidden: false,
      maValues: new Map(),
      volumeEnabled: false,
      volumeValue: null,
      foreignNetEnabled: false,
      foreignValue: null,
      institutionNetEnabled: true,
      institutionValue: 42,
    });
    expect(rows.some((r) => r.paneId === 'investor-foreign')).toBe(false);
    expect(rows.some((r) => r.paneId === 'investor-institution')).toBe(true);
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
