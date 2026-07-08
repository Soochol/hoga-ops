import { describe, expect, it } from 'vitest';
import { groupSignalAlertsByCode } from './groupAlerts';
import type { SignalAlertEvent } from '../api/signalAlerts';

function alert(over: Partial<SignalAlertEvent> & { code: string; t_ms: number }): SignalAlertEvent {
  return {
    type: 'signal_alert',
    id: `${over.code}-${over.t_ms}`,
    signal: 'sell_total_renewal',
    seq: over.t_ms,
    name: over.code,
    date: '20260708',
    source: 'ws',
    value: 1000,
    baseline: 1000,
    ratio_pct: 100,
    use_intra_minute_max: false,
    ...over,
  };
}

describe('groupSignalAlertsByCode', () => {
  it('collapses repeated codes, keeping count, peak ratio, and latest firing', () => {
    const groups = groupSignalAlertsByCode([
      alert({ code: 'A', t_ms: 100, ratio_pct: 105, value: 10 }),
      alert({ code: 'A', t_ms: 300, ratio_pct: 118, value: 30 }),
      alert({ code: 'A', t_ms: 200, ratio_pct: 110, value: 20 }),
      alert({ code: 'B', t_ms: 250, ratio_pct: 101, value: 5 }),
    ]);
    expect(groups).toHaveLength(2);
    const a = groups.find((g) => g.code === 'A')!;
    expect(a.count).toBe(3);
    expect(a.peakRatioPct).toBe(118);        // strongest across the 3
    expect(a.latestTMs).toBe(300);           // most recent firing
    expect(a.latestValue).toBe(30);          // latest firing's value, not the peak's
  });

  it('orders groups by latest firing, newest first', () => {
    const groups = groupSignalAlertsByCode([
      alert({ code: 'OLD', t_ms: 100 }),
      alert({ code: 'NEW', t_ms: 900 }),
      alert({ code: 'MID', t_ms: 500 }),
    ]);
    expect(groups.map((g) => g.code)).toEqual(['NEW', 'MID', 'OLD']);
  });

  it('is order-independent for peak/latest (input need not be sorted)', () => {
    const groups = groupSignalAlertsByCode([
      alert({ code: 'A', t_ms: 300, ratio_pct: 110 }),
      alert({ code: 'A', t_ms: 100, ratio_pct: 130 }), // earlier but strongest
    ]);
    expect(groups[0].peakRatioPct).toBe(130);
    expect(groups[0].latestTMs).toBe(300);
  });

  it('empty input → empty output', () => {
    expect(groupSignalAlertsByCode([])).toEqual([]);
  });
});
