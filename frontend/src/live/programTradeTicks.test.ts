import { describe, expect, it } from 'vitest';
import { buildProgramTradeTicks, combineProgramTradeHistory, mergeProgramTradeTicks } from './programTradeTicks';

const T = Date.UTC(2026, 9, 15, 5, 52, 52);
const date = '20261015';
const frame = (extra: Record<string, unknown> = {}) => ({ t_ms: T, price: 125500, event_delta_qty: 37, ...extra });

describe('program trade tape', () => {
  it('uses supplier history for completed seconds and retains only the newer WS tail', () => {
    const past = buildProgramTradeTicks([frame({ event_id: 'ka90008:z' }), frame({ event_id: 'ka90008:a' })], date);
    const live = buildProgramTradeTicks([frame({ t_ms: T - 1000 }), frame({ t_ms: T + 999 }), frame({ t_ms: T + 1000 })], date);
    expect(combineProgramTradeHistory(live, past, T).map(t => t.tMs)).toEqual([T + 1000, T, T]);
    expect(combineProgramTradeHistory(live, past, T).slice(1).map(t => t.eventId)).toEqual(['ka90008:a', 'ka90008:z']);
    expect(combineProgramTradeHistory(live, [], null)).toHaveLength(3);
  });
  it('deduplicates the same durable event across live and history while retaining identical distinct reports', () => {
    const live = buildProgramTradeTicks([frame({ event_id: 'a' }), frame({ event_id: 'b' })], date);
    const saved = buildProgramTradeTicks([frame({ event_id: 'a' }), frame({ event_id: 'b' }), frame({ event_id: 'b' })], date);
    expect(mergeProgramTradeTicks(live, saved).map(t => t.eventId)).toEqual(['b', 'a']);
  });
  it('uses the supplied event amount, never the cumulative difference or storage delta', () => {
    expect(buildProgramTradeTicks([
      frame({ net_qty: 100 }),
      frame({ net_qty: 900, event_delta_qty: -12, delta_qty: 800 }),
    ], date).map(t => t.deltaQty)).toEqual([-12, 37]);
  });
  it('preserves receive order and equal-time identical values with distinct keys', () => {
    const ticks = buildProgramTradeTicks([frame(), frame(), frame({ t_ms: T - 1000, price: 125400 })], date);
    expect(ticks.map(t => t.price)).toEqual([125400, 125500, 125500]);
    expect(new Set(ticks.map(t => t.key)).size).toBe(3);
  });
  it.each([undefined, null, 0, NaN, Infinity, 1.5, '37', Number.MAX_SAFE_INTEGER + 1])('skips absent, zero or invalid event quantity %s', event_delta_qty => {
    expect(buildProgramTradeTicks([frame({ event_delta_qty, net_qty: 500, delta_qty: 50 })], date)).toEqual([]);
  });
  it.each([null, 0, -1, NaN, Infinity, 1.5])('keeps the event but leaves invalid price %s blank', price => {
    expect(buildProgramTradeTicks([frame({ price })], date)[0].price).toBeNull();
  });
  it('filters other trading dates and invalid receive times', () => {
    expect(buildProgramTradeTicks([
      frame({ t_ms: T - 86400000 }), frame({ t_ms: T + 86400000 }),
      frame({ t_ms: NaN }), frame({ t_ms: 'bad' }), frame(),
    ], date)).toHaveLength(1);
  });
  it('limits the most recent nonzero events without mutating the input', () => {
    const frames = Array.from({ length: 220 }, (_, i) => frame({ price: 1000 + i }));
    const ticks = buildProgramTradeTicks(frames, date);
    expect(ticks).toHaveLength(200);
    expect(ticks[0].price).toBe(1219);
    expect(ticks.at(-1)?.price).toBe(1020);
    expect(frames[0].price).toBe(1000);
    expect(buildProgramTradeTicks(frames, date, 0)).toEqual([]);
  });
});
