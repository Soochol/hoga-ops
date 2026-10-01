import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LiveSeriesData } from '../api/liveSeries';
import type { TradeSnapshot } from './bucketHogaSeries';
import { createRegularSessionTradeFilter, filterRegularSessionSnapshots } from './regularSessionView';
import { useRegularSessionLiveSeries } from './useRegularSessionLiveSeries';
import { buildHogaSeries, createIncrementalHogaSeriesBuilder } from './buildLiveBundle';

const at = (time: string, date = '2026-10-01') => Date.parse(`${date}T${time}+09:00`);
const trade = (time: string): TradeSnapshot => ({ t_ms: at(time), trades: [{ side: 1, qty: 10 }] });
const live = (trades: TradeSnapshot[]): LiveSeriesData => ({
  initial: undefined, error: null, isLoading: false, ob: [], trade: trades,
  broker: [], program: [], afterHours: [], expected: [],
});

describe('regular-session live streams', () => {
  it('clips book/program timestamps across dates without traversing their payloads', () => {
    const ladder = vi.fn(() => { throw new Error('price ladders must not be visited'); });
    const kept = ['09:00:00', '15:30:00'].map(time => ({ t_ms: at(time), get asks() { return ladder(); } }));
    const previous = { t_ms: at('09:00:00', '2026-09-30') };
    const untimed = { status: 'ready' };
    const filtered = filterRegularSessionSnapshots([
      { t_ms: at('08:59:59.999') }, previous, ...kept,
      { ts_ms: at('15:30:00.001') }, { t: at('16:00:00') }, untimed,
    ]);
    expect(filtered).toEqual([previous, ...kept, untimed]);
    expect(filterRegularSessionSnapshots(kept)).toBe(kept);
    expect(ladder).not.toHaveBeenCalled();
  });

  it('uses event time before snapshot time and preserves mixed snapshots across append/eviction', () => {
    const filter = createRegularSessionTradeFilter();
    const mixed: TradeSnapshot = { t_ms: at('08:59:59'), trades: [
      { side: 1, qty: 99 }, // outside by fallback snapshot time
      { t_ms: at('09:00:00'), side: 1, qty: 10 },
      { t_ms: at('15:30:00'), side: -1, qty: 20 },
      { t_ms: at('15:30:00.001'), side: 1, qty: 99 },
    ] };
    const inside = trade('09:10:00');
    const empty = { t_ms: at('09:10:00'), trades: [] };
    const original = [mixed, inside, empty, trade('16:00:00')];
    const first = filter(original);
    expect(first[0].trades).toEqual(mixed.trades.slice(1, 3));
    expect(first[0].trades[0]).toBe(mixed.trades[1]);
    expect(first[1]).toBe(inside);
    expect(first).toHaveLength(2);
    const appended = trade('09:11:00');
    expect(filter([...original, appended])).toEqual([...first, appended]);
    expect(filter([mixed, appended])[0]).toBe(first[0]);
    expect(mixed.trades).toHaveLength(4);
    const unchanged = [inside, appended];
    expect(filter(unchanged)).toBe(unchanged);
  });

  it('keeps filtered arrays on parent renders and OB-only updates, and restores raw data when disabled', () => {
    const readTime = vi.fn(() => at('09:00:00'));
    const mixed: TradeSnapshot = { t_ms: at('08:59:00'), trades: [
      { side: 1, qty: 99 }, { get t_ms() { return readTime(); }, side: 1, qty: 10 },
    ] };
    const raw = { ...live([mixed]), program: [{ t_ms: at('08:00:00') }, { t_ms: at('09:00:00') }] };
    const { result, rerender } = renderHook(({ raw, enabled }) => useRegularSessionLiveSeries(raw, enabled), {
      initialProps: { raw: raw as LiveSeriesData, enabled: true },
    });
    const first = result.current;
    const initialReads = readTime.mock.calls.length;
    rerender({ raw: { ...raw, isLoading: true }, enabled: true });
    expect(result.current.trade).toBe(first.trade);
    expect(result.current.program).toBe(first.program);
    rerender({ raw: { ...raw, ob: [{ t_ms: at('09:01:00'), total_bid_qty: 1, total_ask_qty: 2 }] }, enabled: true });
    expect(result.current.trade).toBe(first.trade);
    expect(readTime).toHaveBeenCalledTimes(initialReads);
    rerender({ raw, enabled: false });
    expect(result.current).toBe(raw);
    rerender({ raw, enabled: true });
    expect(result.current.trade[0]).toBe(first.trade[0]);
    expect(readTime).toHaveBeenCalledTimes(initialReads);
  });

  it.each([1_000, 3_000, 10_000, 60_000, 180_000, 300_000, 600_000])(
    'does not replay retained trade quantities on an OB flush (%ims bars)', bucketMs => {
      const qty = vi.fn(() => 10);
      const trades = [trade('09:00:00'), {
        t_ms: at('09:01:00'), trades: [{ side: 1, get qty() { return qty(); } }],
      }];
      const raw = live(trades);
      const { result, rerender } = renderHook(({ raw }) => useRegularSessionLiveSeries(raw, true), {
        initialProps: { raw },
      });
      const build = createIncrementalHogaSeriesBuilder();
      const input = () => ({
        todaySession: { open_ms: at('09:00:00'), close_ms: at('15:30:00') },
        pastBundle: null, sseOb: result.current.ob, sseTrade: result.current.trade,
        bucketMs, depthHeatmapEnabled: false, venue: 'KRX',
      });
      build(input());
      qty.mockClear();
      act(() => rerender({ raw: { ...raw, ob: [{ t_ms: at('09:02:00'), total_bid_qty: 100, total_ask_qty: 50 }] } }));
      const output = build(input());
      expect(qty).not.toHaveBeenCalled();
      expect(output).toEqual(buildHogaSeries(input()));
      qty.mockClear();
      rerender({ raw: { ...raw, ob: result.current.ob, trade: [...trades, trade('09:03:00')] } });
      const appended = build(input());
      expect(qty).not.toHaveBeenCalled();
      expect(appended).toEqual(buildHogaSeries(input()));
    },
  );
});
