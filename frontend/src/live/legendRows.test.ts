import { describe, it, expect } from 'vitest';
import {
  buildLegendRows,
  readSeriesValue,
  type LegendFlagInput,
  type PaneCellInput,
} from './legendRows';
import type { LiveMAConfig } from '../state/livePage';

const ma = (over: Partial<LiveMAConfig> & { id: string }): LiveMAConfig => ({
  enabled: true,
  period: 5,
  color: '#EC4899',
  lineWidth: 1,
  source: 'close',
  ...over,
});

// 슬롯 0개 = MA 행 없음. 마스터 토글이 슬롯의 `enabled` 로 접힌 뒤로 행의 유무를
// 정하는 것은 **슬롯의 존재**뿐이다(켜짐 여부가 아니다 — 꺼진 슬롯은 dim 칩으로 남는다).
const base = {
  movingAverages: [] as LiveMAConfig[],
  maValues: new Map<string, number>(),
  paneCells: [] as PaneCellInput[],
};

describe('buildLegendRows — candle OHLC row', () => {
  const ohlc = {
    open: 265000, high: 266000, low: 264000, close: 265750,
    openPct: 0, highPct: 0.37, lowPct: -0.37, closePct: 0.28,
  };

  it('emits the OHLC row unconditionally (no toggle) as the FIRST candle row', () => {
    const rows = buildLegendRows({
      ...base,
      ohlc,
      movingAverages: [ma({ id: 'ma-1', period: 5 })],
      maValues: new Map([['ma-1', 311400]]),
    });
    // First row overall is the OHLC row (pinned top), MA row follows.
    expect(rows[0].kind).toBe('ohlc');
    expect(rows[0].paneId).toBe('candle');
    expect(rows[0].kind === 'ohlc' && rows[0].close).toBe(265750);
    expect(rows[0].kind === 'ohlc' && rows[0].highPct).toBe(0.37);
    expect(rows[1]?.kind).toBe('ma');
  });

  it('shows OHLC even when every other candle indicator is off', () => {
    const rows = buildLegendRows({ ...base, ohlc });
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('ohlc');
  });

  it('omits the OHLC row when there is no candle data (ohlc null/absent)', () => {
    expect(buildLegendRows({ ...base }).find((r) => r.kind === 'ohlc')).toBeUndefined();
    expect(buildLegendRows({ ...base, ohlc: null }).find((r) => r.kind === 'ohlc')).toBeUndefined();
  });

  it('keeps null pcts (earliest bar) intact for the renderer to blank', () => {
    const rows = buildLegendRows({
      ...base,
      ohlc: { ...ohlc, openPct: null, highPct: null, lowPct: null, closePct: null },
    });
    expect(rows[0].kind === 'ohlc' && rows[0].closePct).toBeNull();
  });
});

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
    expect(candle?.kind === 'ma' && candle.mas.every((m) => m.enabled)).toBe(true);
  });

  it('keeps disabled slots as chips (dim, valueless) so they can be re-enabled', () => {
    const rows = buildLegendRows({
      ...base,
      movingAverages: [ma({ id: 'ma-1' }), ma({ id: 'ma-2', enabled: false })],
      maValues: new Map([['ma-1', 1], ['ma-2', 2]]),
    });
    const candle = rows.find((r) => r.paneId === 'candle');
    expect(candle?.kind === 'ma' && candle.mas.map((m) => m.id)).toEqual(['ma-1', 'ma-2']);
    expect(candle?.kind === 'ma' && candle.mas[1].enabled).toBe(false);
    // 꺼진 칩은 값을 싣지 않는다 — 오버레이가 series 를 비우므로 읽을 값이 없고,
    // 숫자를 남겨 두면 켜진 칩과 구별되지 않는다.
    expect(candle?.kind === 'ma' && candle.mas[1].value).toBeNull();
  });

  it('keeps the row when every slot is disabled (the eye must stay reachable)', () => {
    const rows = buildLegendRows({
      ...base,
      movingAverages: [ma({ id: 'ma-1', enabled: false })],
      maValues: new Map([['ma-1', 999]]),
    });
    const candle = rows.find((r) => r.paneId === 'candle');
    expect(candle?.kind).toBe('ma');
    expect(candle?.kind === 'ma' && candle.mas).toHaveLength(1);
  });

  it('omits the candle row only when there are no slots at all (user deleted them)', () => {
    const rows = buildLegendRows({ ...base, movingAverages: [] });
    expect(rows.find((r) => r.paneId === 'candle')).toBeUndefined();
  });
});

describe('buildLegendRows — candle daily-MA row', () => {
  const dailyBase = {
    ...base,
    dailyMovingAverages: [ma({ id: 'dma-1', period: 20, color: '#3485FA' })],
    dailyMaValues: new Map<string, number>(),
    dailyMaApplicable: true,
  };

  it('builds the daily-MA row from enabled slots; value=null when missing', () => {
    const rows = buildLegendRows({
      ...dailyBase,
      dailyMovingAverages: [ma({ id: 'dma-1', period: 20 }), ma({ id: 'dma-2', period: 60 })],
      dailyMaValues: new Map([['dma-1', 70000]]),
    });
    const row = rows.find((r) => r.kind === 'daily-ma');
    expect(row?.kind === 'daily-ma' && row.mas[0].value).toBe(70000);
    expect(row?.kind === 'daily-ma' && row.mas[1].value).toBeNull();
  });

  it('omits the row on non-minute timeframes (overlay clears its series on D/W/M)', () => {
    const rows = buildLegendRows({ ...dailyBase, dailyMaApplicable: false });
    expect(rows.some((r) => r.kind === 'daily-ma')).toBe(false);
  });

  it('omits the row when there are no daily slots (user deleted them)', () => {
    const rows = buildLegendRows({ ...dailyBase, dailyMovingAverages: [] });
    expect(rows.some((r) => r.kind === 'daily-ma')).toBe(false);
  });

  it('coexists with the intraday MA row on the candle pane (MA first)', () => {
    const rows = buildLegendRows({
      ...dailyBase,
      movingAverages: [ma({ id: 'ma-1' })],
    });
    const candleKinds = rows.filter((r) => r.paneId === 'candle').map((r) => r.kind);
    expect(candleKinds).toEqual(['ma', 'daily-ma']);
  });
});

describe('buildLegendRows — flag rows', () => {
  const flags: LegendFlagInput[] = [
    { type: 'ask-peak', instanceId: 'main', paneId: 'candle', label: '당일 매도 최대벽', enabled: true, applicable: true, hidden: false, cells: [], swatches: ['#F04452'] },
    { type: 'bid-peak', instanceId: 'main', paneId: 'candle', label: '당일 매수 최대벽', enabled: false, applicable: true, hidden: false, cells: [], swatches: ['#3485FA'] },
    { type: 'depth-heatmap', instanceId: 'main', paneId: 'candle', label: '호가 잔량 히트맵', enabled: true, applicable: false, hidden: false, cells: [], swatches: ['#3485FA', '#F04452'] },
  ];

  it('emits rows only for enabled && applicable flags, in input order', () => {
    const rows = buildLegendRows({ ...base, indicatorFlags: flags });
    const flagRows = rows.filter((r) => r.kind === 'flag');
    expect(flagRows.map((r) => r.kind === 'flag' && r.type)).toEqual(['ask-peak']);
    expect(flagRows[0].kind === 'flag' && flagRows[0].label).toBe('당일 매도 최대벽');
    expect(flagRows[0].kind === 'flag' && flagRows[0].swatches).toEqual(['#F04452']);
  });

  it('orders candle rows ma → daily-ma → flags', () => {
    const rows = buildLegendRows({
      ...base,
      movingAverages: [ma({ id: 'ma-1' })],
      dailyMovingAverages: [ma({ id: 'dma-1' })],
      dailyMaApplicable: true,
      indicatorFlags: [
        { type: 'trade-volume-poc', instanceId: 'main', paneId: 'candle', label: '당일 최대 매물대', enabled: true, applicable: true, hidden: false, cells: [], swatches: ['#A855F7'] },
      ],
    });
    expect(rows.filter((r) => r.paneId === 'candle').map((r) => r.kind)).toEqual([
      'ma',
      'daily-ma',
      'flag',
    ]);
  });

  it('passes hidden and value cells through to the flag row', () => {
    const rows = buildLegendRows({
      ...base,
      indicatorFlags: [
        {
          type: 'ask-peak',
          instanceId: 'main',
          paneId: 'candle',
          label: '당일 매도 최대벽',
          enabled: true,
          applicable: true,
          hidden: true,
          swatches: ['#F04452'],
          cells: [{ key: 'ask-peak', value: '300,000, 12.3만' }],
        },
      ],
    });
    const row = rows.find((r) => r.kind === 'flag');
    expect(row?.kind === 'flag' && row.hidden).toBe(true);
    expect(row?.kind === 'flag' && row.cells[0].value).toBe('300,000, 12.3만');
  });

  it('emits a ratio-pane flag (거래원 등장) AFTER the ratio cells row', () => {
    const rows = buildLegendRows({
      ...base,
      paneCells: [
        {
          paneId: 'ratio',
          title: '호가비',
          toggleKey: 'ratioEnabled',
          cells: [{ key: 'r', label: '호가비', value: 3.4 }],
        },
      ],
      indicatorFlags: [
        { type: 'broker-late-entry', instanceId: 'main', paneId: 'ratio', label: '신규 거래원 등장', enabled: true, applicable: true, hidden: false, cells: [], swatches: ['#F04452', '#3485FA'] },
      ],
    });
    const ratioRows = rows.filter((r) => r.paneId === 'ratio');
    expect(ratioRows.map((r) => r.kind)).toEqual(['cells', 'flag']);
    expect(ratioRows[1].kind === 'flag' && ratioRows[1].type).toBe('broker-late-entry');
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
