import { buildHogaSeries, createIncrementalHogaSeriesBuilder } from './buildLiveBundle';
import { computeTradeVolumePoc, computeCandleVolumePocs, IncrementalTradeVolumePoc } from './tradeVolumePoc';
import { regularSessionBinningSegment, firstTrailingSinglePriceBookMs } from './continuousTradeVolumeDistribution';
import type { RangeSegment } from '../api/types';
import { describe, expect, it } from 'vitest';
import { aggregateCandles, keepMinuteSessionCandles } from './aggregateCandles';
import { collapseClosingAuction } from './collapseClosingAuction';
import { classifyWithinSegment } from '../util/sessionTime';
import { overlayLiveTradesOnCandles, overlayLiveTradesOnCalendarCandles } from './useLiveBundle';
import type { TradeSnapshot } from './bucketHogaSeries';
import { isAfterHoursSinglePriceWindow } from '../api/liveAfterHoursBook';
import { bookSessionControl, defaultBookSessionMode, hasBookSessionToggle } from './bookSessionMode';
import { isLiveVenueSessionNow, liveVenueSessionBoundsMs, liveVenueSessionWindowLabel } from './liveVenuePolicy';
import { isKrxAftermarketWindow, krxBookPhaseLabel } from '../util/stockSessions';

const at = (day: number, hour: number, minute = 0) => Date.UTC(2026, 8, day, hour - 9, minute);

describe('KRX after-market launch', () => {
  it.each([
    [11, 17, 0, false], [14, 15, 59, false], [14, 16, 0, true],
    [14, 19, 59, true], [14, 20, 0, false], [19, 17, 0, false],
  ] as const)('clock %i %i:%i = %s', (day, hour, minute, expected) => {
    expect(isKrxAftermarketWindow(at(day, hour, minute))).toBe(expected);
  });

  it('retires the single-price source while keeping historical behavior', () => {
    expect(isAfterHoursSinglePriceWindow(at(11, 17))).toBe(true);
    expect(isAfterHoursSinglePriceWindow(at(14, 17))).toBe(false);
    expect(defaultBookSessionMode(at(14, 17))).toBe('regular');
    expect(hasBookSessionToggle(false, false, at(14, 17))).toBe(false);
    expect(hasBookSessionToggle(false, false, at(11, 17))).toBe(true);
  });

  it('opens live refresh and date-specific axes without changing old charts', () => {
    expect(isLiveVenueSessionNow('KRX', at(14, 17))).toBe(true);
    expect(isLiveVenueSessionNow('KRX', at(14, 15, 45))).toBe(false);
    expect(liveVenueSessionBoundsMs('20260911', 'KRX').close_ms).toBe(at(11, 15, 30));
    expect(liveVenueSessionBoundsMs('20260914', 'KRX')).toEqual({ open_ms: at(14, 9), close_ms: at(14, 20) });
    expect(liveVenueSessionWindowLabel('KRX', '20260914')).toBe('09:00–15:30 · 16:00–20:00');
  });

  it('does not claim participation from NXT eligibility or a stale regular book', () => {
    for (const nxtEnabled of [true, false, null]) {
      expect(bookSessionControl({
        nxtEnabled, venue: 'KRX', isSpot: false, nowMs: at(14, 17), ladderAtMs: at(14, 15, 29),
      })).toEqual({ kind: 'label', label: '애프터마켓 · 수신 대기' });
      expect(bookSessionControl({
        nxtEnabled, venue: 'KRX', isSpot: false, nowMs: at(14, 17), ladderAtMs: at(14, 17),
      })).toEqual({ kind: 'label', label: '애프터마켓' });
    }
    expect(krxBookPhaseLabel(at(14, 20), at(14, 19, 59))).toBe('애프터마켓 · 마지막');
  });
});


it('keeps the regular auction and the final evening candles distinct', () => {
  const c = (h: number, m: number) => ({ ts_ms: at(14, h, m), open: 100, high: 120,
    low: 90, close: 110, vol_a: 10, vol_b: 0 });
  const input = [c(15, 25), c(15, 30), c(19, 50), c(19, 59)];
  const result = collapseClosingAuction(input, new Map([['20260914', { close_ms: at(14, 20) }]]));
  expect(result).toHaveLength(3);
  expect(result[0].open).toBe(110);
  expect(result[1]).toBe(input[2]);
  expect(result[2]).toBe(input[3]);
  const segment = { sessionOpenMs: at(14, 9), sessionCloseMs: at(14, 20) };
  expect(classifyWithinSegment(segment, at(14, 15, 25))).toBe('auction');
  expect(classifyWithinSegment(segment, at(14, 19, 55))).toBe('regular');
});

it.each([120, 240])('starts %i-minute candles at 16:00 and protects the official daily close', minutes => {
  const raw = [[15, 100], [16, 110], [17, 120]].map(([h, p]) => ({ t_ms: at(14, h),
    open: p, high: p, low: p, close: p, volume: 1 }));
  const result = aggregateCandles(keepMinuteSessionCandles(raw, 'KRX'), minutes * 60, 'KRX');
  expect(result).toHaveLength(2);
  expect(result[1]).toMatchObject({ t_ms: at(14, 16), open: 110, close: 120 });
  const base = [{ ts_ms: at(14, 15), open: 100, high: 100, low: 100, close: 100, vol_a: 1, vol_b: 0 }];
  const trades: TradeSnapshot[] = [{ t_ms: at(14, 16), kind: 'trade', venue: 'KRX',
    trades: [{ t_ms: at(14, 16), price: 110, qty: 1, side: 1 }] }];
  const live = overlayLiveTradesOnCandles(base, trades, minutes * 60_000, 'KRX', true);
  expect(live[1]).toMatchObject({ ts_ms: at(14, 16), open: 110, close: 110 });
  expect(overlayLiveTradesOnCalendarCandles(base, trades, 'D', 'KRX')).toBe(base);
});

it('labels known ETF/ETN exclusions without inferring eligibility for other stocks', () => {
  expect(bookSessionControl({ nxtEnabled: false, venue: 'KRX', isSpot: false,
    nowMs: at(14, 17), aftermarketExcluded: true })).toEqual({ kind: 'label', label: '애프터마켓 대상 제외' });
});


it.each([120, 240])('aligns %i-minute live quote, fill and heatmap buckets with candles', minutes => {
  const base = { todaySession: { open_ms: at(14, 9), close_ms: at(14, 20) },
    pastBundle: null, bucketMs: minutes * 60000 };
  const ob = [15, 16, 17, 18, 19].map(h => ({ t_ms: at(14, h), total_ask_qty: 100, total_bid_qty: 200,
    asks: Array.from({length:10}, (_, i) => ({price:110+i, qty:10})),
    bids: Array.from({length:10}, (_, i) => ({price:100-i, qty:20})) }));
  const trade = ob.map(o => ({ t_ms:o.t_ms, trades:[{t_ms:o.t_ms, price:100,qty:3,side:1}] }));
  const input = { ...base, sseOb:ob, sseTrade:trade };
  const batch = buildHogaSeries(input);
  const incremental = createIncrementalHogaSeriesBuilder();
  incremental({...input, sseOb:ob.slice(0,2), sseTrade:trade.slice(0,2)});
  expect(incremental(input)).toEqual(batch);
  const expected = minutes === 120 ? [at(14,15),at(14,16),at(14,18)] : [at(14,13),at(14,16)];
  expect(batch.quote_ratio.points.map(p=>p.t)).toEqual(expected);
  expect(batch.fill_strength.points.map(p=>p.t)).toEqual(expected);
  expect(batch.depth_heatmap_today.map(p=>p.tMs)).toEqual(expected);
  expect(batch.fill_strength.points.reduce((sum,p)=>sum+p.buy_qty,0)).toBe(15);
});

it('includes afternoon POC in batch, incremental and candle fallback while preserving UN', () => {
  const segment: RangeSegment = { date:'20260914',session_open_ms:at(14,9),session_close_ms:at(14,20),source:'kiwoom_live' };
  expect(regularSessionBinningSegment(segment,'KRX').session_close_ms).toBe(at(14,20));
  expect(regularSessionBinningSegment(segment,'UN').session_close_ms).toBe(at(14,15,30));
  const candles = [{ts_ms:at(14,17),open:100,high:110,low:90,close:100,vol_a:10,vol_b:0}];
  const trades = [{t_ms:at(14,17),trades:[{price:100,qty:10,side:1}]}];
  const batch = computeTradeVolumePoc(trades,{date:segment.date,segment,candles,rangeCount:2});
  expect(batch).not.toBeNull();
  const incremental = new IncrementalTradeVolumePoc().update(trades,{date:segment.date,bandPct:0.005,
    rangeMin:90,rangeMax:110,rangeCount:2,sessionOpenMs:at(14,9),sessionCloseMs:at(14,20),continuousBeforeMs:null});
  expect(incremental).toEqual(batch);
  expect(computeCandleVolumePocs(candles,[segment],{rangeCount:2})).toHaveLength(1);
  expect(computeTradeVolumePoc(trades,{date:segment.date,venue:'UN'})).toBeNull();
  const deep = Array.from({length:10},()=>({price:100,qty:10}));
  const books = [{t_ms:at(14,15),total_ask_qty:100,total_bid_qty:100,asks:deep,bids:deep},
    {t_ms:at(14,15,25),total_ask_qty:100,total_bid_qty:100,asks:deep.slice(0,3),bids:deep.slice(0,3)}];
  expect(firstTrailingSinglePriceBookMs(books,at(14,20),at(14,9))).toBeNull();
});

it('uses explicit venue with shortened or delayed sessions and resets incremental state on venue change', () => {
  const deep = Array.from({length:10}, () => ({price:100,qty:10}));
  const input = {todaySession:{open_ms:at(14,10),close_ms:at(14,19)},pastBundle:null,
    sseOb:[{t_ms:at(14,17),total_ask_qty:100,total_bid_qty:100,asks:deep,bids:deep}],
    sseTrade:[{t_ms:at(14,17),trades:[{price:100,qty:10,side:1}]}],bucketMs:240*60_000};
  const builder = createIncrementalHogaSeriesBuilder();
  for (const venue of ['KRX', 'UN', 'NXT', 'KRX']) {
    const result = builder({...input,venue});
    expect(result).toEqual(buildHogaSeries({...input,venue}));
    const expected = at(14,venue === 'KRX' ? 16 : 17);
    expect(result.quote_ratio.points[0].t).toBe(expected);
    expect(result.fill_strength.points[0].t).toBe(expected);
    expect(result.depth_heatmap_today[0].tMs).toBe(expected);
  }
});
