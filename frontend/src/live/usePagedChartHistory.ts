import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import type { IChartApi, Time } from 'lightweight-charts';
import type { RangeBundle } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import { realMsToVirtualSeconds } from './viewportAnchor';
import { safeUnsubscribe } from '../chart/util/safeUnsubscribe';

export interface PagedChartHistory {
  hasMore: boolean;
  loading: boolean;
  blocked: boolean;
  loadOlder: () => void;
}

/** Cursor pages have no domestic date-window/floor. Preserve the viewport at
 * the data commit, including wheel/pointer changes made while HTTP is pending. */
export function usePagedChartHistory(chart: IChartApi | null, axis: VirtualAxis,
  bundle: RangeBundle | null, control: PagedChartHistory | undefined, containerRef: RefObject<HTMLDivElement | null>) {
  // Domestic backfill freezes a finite gesture budget too. Cursor pages must
  // not turn a large wheel zoom into an unbounded provider walk.
  const allowance = useRef(3);
  const state = useRef(control);
  state.current = control;
  const previous = useRef<{ chart: IChartApi; axis: VirtualAxis; bundle: RangeBundle } | null>(null);
  const snap = useRef<{ from: number; to: number; real: number; index: number } | null>(null);
  useLayoutEffect(() => {
    snap.current = null;
    const old = previous.current;
    if (old?.chart !== chart) allowance.current = 3;
    if (!control || !chart || !bundle?.candles.length) { previous.current = null; return; }
    if (old?.chart === chart && old.bundle.candles.length &&
      bundle.candles[0].ts_ms !== old.bundle.candles[0].ts_ms) {
      const ts = chart.timeScale();
      const range = ts.getVisibleLogicalRange();
      // The old last bar always survives a prepend. Its logical index also
      // accounts for the chart's union timeline, unlike candle-array offsets.
      const real = old.bundle.candles.at(-1)!.ts_ms;
      const index = ts.timeToIndex(realMsToVirtualSeconds(old.axis, real) as Time);
      if (range && index !== null) snap.current = { ...range, real, index };
    }
    previous.current = { chart, axis, bundle };
  }, [chart, axis, bundle, !!control]);
  useEffect(() => {
    const saved = snap.current;
    snap.current = null;
    if (!saved || !chart) return;
    const ts = chart.timeScale();
    const index = ts.timeToIndex(realMsToVirtualSeconds(axis, saved.real) as Time);
    if (index === null) return;
    const delta = index - saved.index;
    const from = saved.from + delta, to = saved.to + delta;
    ts.setVisibleLogicalRange({ from, to });
    // Commit lwc's internal right offset too; subsequent polling must not
    // resurrect the pre-prepend scroll position.
    const last = bundle?.candles.at(-1);
    const latest = last ? ts.timeToIndex(realMsToVirtualSeconds(axis, last.ts_ms) as Time) : null;
    if (latest !== null) ts.scrollToPosition(to - latest, false);
  }, [chart, axis, bundle]);

  useEffect(() => {
    if (!chart || !control) return;
    const ts = chart.timeScale();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      clearTimeout(timer);
      const value = state.current;
      if (!value?.hasMore || value.loading || value.blocked || allowance.current <= 0) return;
      const range = ts.getVisibleLogicalRange();
      if (!range || range.from > 50) return;
      timer = setTimeout(() => {
        const current = state.current;
        const now = ts.getVisibleLogicalRange();
        if (current?.hasMore && !current.loading && !current.blocked && now && now.from <= 50 && allowance.current > 0) {
          allowance.current--;
          current.loadOlder();
        }
      }, 150);
    };
    const onInput = () => { allowance.current = 3; check(); };
    const element = containerRef.current;
    element?.addEventListener('wheel', onInput, { passive: true, capture: true });
    element?.addEventListener('pointerdown', onInput, true);
    ts.subscribeVisibleLogicalRangeChange(check);
    check();
    return () => {
      clearTimeout(timer);
      element?.removeEventListener('wheel', onInput, true);
      element?.removeEventListener('pointerdown', onInput, true);
      safeUnsubscribe(() => ts.unsubscribeVisibleLogicalRangeChange(check));
    };
  }, [chart, bundle, !!control, control?.hasMore, control?.loading, control?.blocked, containerRef]);
}
