import { act, render, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { SecondVolumeDistributionWindow } from './SecondVolumeDistributionWindow';
import { useLiveCursorStore } from '../useLiveCursorStore';
import { useLiveOrderbookAtCursor, useLiveBrokersAtCursor } from '../../api/useLiveCursor';
import { DataContext } from './DataContext';

const fixture = vi.hoisted(() => {
  const t = Date.parse('2026-09-30T09:00:00+09:00');
  const reads = { prices: 0 };
  return { t, reads, quantities: [] as number[], query: { data: { prices: Array.from({ length: 4500 }, (_, i) => ({
    t_ms: t+i*1000, get price() { reads.prices++; return 100+i%20; }, side: 1 as const, qty: 1, count: 1,
  })), bars: [] }, isError: false }, closeRefs: [] as unknown[] };
});
vi.mock('../../api/secondAggregates', () => ({ useSecondAggregates: () => fixture.query }));
vi.mock('../useEffectiveVenue', () => ({ useEffectiveVenue: () => 'KRX' }));
vi.mock('../../state/sourcePreference', () => ({ useOrderflowSourcePref: () => 'kiwoom_live' }));
vi.mock('../../api/brokerSeries', () => ({ useBrokerSeriesForDay: () => undefined }));
vi.mock('../../api/client', () => ({ apiGet: vi.fn() }));
vi.mock('../../sidebar/VolumeDistributionCard', () => ({ VolumeDistributionCard: (p: {
  closePoints: unknown; profile: { bins: { qty: number }[] } | null;
}) => {
  fixture.closeRefs.push(p.closePoints);
  fixture.quantities.push(p.profile?.bins.reduce((sum, bin) => sum + bin.qty, 0) ?? 0);
  return null;
} }));

it.each([false, true])('reuses seconds profile preparation across 60 same-date cursor changes, cutoff=%s', cutoff => {
  useLiveCursorStore.getState().resetCursor();
  fixture.closeRefs.length = 0; fixture.quantities.length = 0; fixture.reads.prices = 0;
  const view = render(<SecondVolumeDistributionWindow win={{ id: 'vd', kind: 'vdist', group: 1, rect: {x: 0,y: 0,w: .5,h: .5} }} code="005930" date="20260930" timeframe="10s" settings={{rangeCount: 10,color: 'red',maxColor: 'blue',hoverCutoffEnabled: cutoff,regularSessionOnly: true}} />);
  expect(fixture.reads.prices).toBeGreaterThan(0);
  fixture.reads.prices = 0;
  for (let i=0; i<60; i++) act(() => useLiveCursorStore.getState().setSidebarCursor(fixture.t+i*1000, {windowId: 'chart',group: 1,code: '005930',timeframe: '10s'}));
  expect(fixture.reads.prices).toBe(0);
  expect(fixture.quantities.at(-1)).toBe(cutoff ? 69 : 4500);
  expect(new Set(fixture.closeRefs).size).toBe(1);
  view.unmount(); useLiveCursorStore.getState().resetCursor();
});

it.each(['book', 'broker'])('does not render inactive %s hook on unrelated cursor changes', kind => {
  useLiveCursorStore.getState().resetCursor(); let renders=0;
  const view = renderHook(() => { renders++; return kind === 'book' ? useLiveOrderbookAtCursor({code: null,timeframe: null,venue: 'KRX'}) : useLiveBrokersAtCursor({code: null,timeframe: null,venue: 'KRX'}); });
  act(() => useLiveCursorStore.getState().setSidebarCursor(fixture.t-1000, {windowId: 'other',group: 2,code: '000660',timeframe: '10s'}));
  const initial = renders;
  for (let i=0; i<60; i++) act(() => useLiveCursorStore.getState().setSidebarCursor(fixture.t+i*1000, {windowId: 'other',group: 2,code: '000660',timeframe: '10s'}));
  expect(renders-initial).toBe(0);
  view.unmount(); useLiveCursorStore.getState().resetCursor();
});

it('reuses the data context date formatter across renders', () => {
  const Original = Intl.DateTimeFormat;
  const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (...args: ConstructorParameters<typeof Intl.DateTimeFormat>) { return new Original(...args); });
  const view = render(<DataContext mode="커서" time={fixture.t} />);
  for (let i=1; i<=60; i++) view.rerender(<DataContext mode="커서" time={fixture.t+i*1000} />);
  expect(spy).not.toHaveBeenCalled();
  view.unmount(); spy.mockRestore();
});
