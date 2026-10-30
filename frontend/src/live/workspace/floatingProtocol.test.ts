import { describe, expect, it } from 'vitest';
import { applyFloatingChanges, floatingChanges } from './floatingProtocol';

describe('floating workspace patches', () => {
  it('merges simultaneous edits by window and leaf, preserving the owner layout', () => {
    const base = { windows: { a: { rect: { x: 0.2 }, chart: { timeframe: '1m', hoverLinked: true } }, b: { group: 1 } }, groupSymbols: { 1: 'A' } };
    const detached = { ...base, windows: { ...base.windows, a: { ...base.windows.a, chart: { ...base.windows.a.chart, timeframe: 'D' } } } };
    const owner = { ...base, windows: { ...base.windows, a: { ...base.windows.a, chart: { ...base.windows.a.chart, hoverLinked: false } }, b: { group: 2 } } };
    const merged = applyFloatingChanges(owner, floatingChanges(base, detached));
    expect(merged.windows.a).toEqual({ rect: { x: 0.2 }, chart: { timeframe: 'D', hoverLinked: false } });
    expect(merged.windows.b.group).toBe(2);
  });
  it('transports pin removal, added windows and order input without losing zero or false', () => {
    const before = { windows: { a: { pinned: { code: '005930' }, order: { amount: 10, sound: true } } } };
    const after = { windows: { a: { order: { amount: 0, sound: false } }, b: { kind: 'account-fills' } } };
    expect(applyFloatingChanges(before, floatingChanges(before, after))).toEqual(after);
  });
  it('does not echo cloned snapshots that contain unchanged arrays', () => {
    const state = { chart: { colors: ['red', 'blue'], ranges: [1, 2] } };
    expect(floatingChanges(state, structuredClone(state))).toEqual([]);
  });
  it('rejects prototype paths and excessively deep writes', () => {
    const state = { windows: {} };
    expect(applyFloatingChanges(state, [{ path: ['__proto__', 'floating'], value: true }, { path: Array(30).fill('a'), value: true }])).toEqual(state);
    expect(Object.hasOwn(Object.prototype, 'floating')).toBe(false);
  });
});
