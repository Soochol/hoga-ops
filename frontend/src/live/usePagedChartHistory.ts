import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import type { IChartApi, Time } from 'lightweight-charts';
import type { RangeBundle } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import { realMsToVirtualSeconds } from './viewportAnchor';
import { safeUnsubscribe } from '../chart/util/safeUnsubscribe';

export interface PagedChartHistory {
  /** Opt into gesture-only paging with this many pages per input. */
  pagesPerGesture?: number;
  /** Fill the deficit captured after a gesture, within the source's page/floor limits. */
  fillViewport?: boolean;
  hasMore: boolean;
  loading: boolean;
  blocked: boolean;
  loadOlder: () => void | Promise<unknown>;
}

/** Cursor sources own their page/date limits. Preserve the viewport at the
 * data commit, including wheel/pointer changes made while HTTP is pending. */
export function usePagedChartHistory(chart: IChartApi | null, axis: VirtualAxis,
  bundle: RangeBundle | null, control: PagedChartHistory | undefined, containerRef: RefObject<HTMLDivElement | null>) {
  // Domestic backfill freezes a finite gesture budget too. Cursor pages must
  // not turn a large wheel zoom into an unbounded provider walk.
  const allowance = useRef(control?.fillViewport || control?.pagesPerGesture !== undefined ? 0 : 3);
  const fill = useRef<{ remaining: number } | null>(null);
  const gesture = useRef(false);
  const request = useRef<object | null>(null);
  const recheck = useRef<(() => void) | null>(null);
  const state = useRef(control);
  state.current = control;
  const previous = useRef<{ chart: IChartApi; axis: VirtualAxis; bundle: RangeBundle } | null>(null);
  const snap = useRef<{ from: number; to: number; real: number; index: number } | null>(null);
  useLayoutEffect(() => {
    snap.current = null;
    const old = previous.current;
    if (old?.chart !== chart) {
      allowance.current = control?.fillViewport || control?.pagesPerGesture !== undefined ? 0 : 3;
      fill.current = null;
      gesture.current = false;
      request.current = null;
    }
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
    // Count only prepended timeline slots. Polling, sparse/empty pages and
    // viewport restoration must never enlarge the goal frozen by the input.
    if (fill.current) fill.current.remaining -= Math.max(0, delta);
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
      if (!value?.hasMore || value.blocked) {
        fill.current = null;
        gesture.current = false;
        return;
      }
      if (value.loading || request.current) return;
      if (value.fillViewport ? !gesture.current && !fill.current : allowance.current <= 0) return;
      const range = ts.getVisibleLogicalRange();
      if (!range || (!value.fillViewport && range.from > 50)) return;
      timer = setTimeout(() => {
        const current = state.current;
        const now = ts.getVisibleLogicalRange();
        if (!current?.hasMore || current.loading || current.blocked || !now || request.current) return;
        if (current.fillViewport) {
          if (gesture.current) {
            gesture.current = false;
            // Capture after the wheel/drag has updated lwc's range. The small
            // left buffer matches the existing cursor-page prefetch threshold.
            fill.current = { remaining: Math.ceil(50 - now.from) };
          }
          if (!fill.current || fill.current.remaining <= 0 || now.from > 50) {
            fill.current = null;
            return;
          }
          const token = {};
          request.current = token;
          Promise.resolve().then(() => current.loadOlder()).then(() => {
            if (request.current !== token) return;
            request.current = null;
            recheck.current?.();
          }, () => {
            if (request.current !== token) return;
            request.current = null;
            fill.current = null;
            gesture.current = false;
          });
        } else if (now.from <= 50 && allowance.current > 0) {
          allowance.current--;
          current.loadOlder();
        }
      }, 150);
    };
    const onInput = () => {
      if (state.current?.fillViewport) gesture.current = true;
      else allowance.current = state.current?.pagesPerGesture ?? 3;
      check();
    };
    const element = containerRef.current;
    element?.addEventListener('wheel', onInput, { passive: true, capture: true });
    element?.addEventListener('pointerdown', onInput, true);
    ts.subscribeVisibleLogicalRangeChange(check);
    recheck.current = check;
    check();
    return () => {
      clearTimeout(timer);
      recheck.current = null;
      element?.removeEventListener('wheel', onInput, true);
      element?.removeEventListener('pointerdown', onInput, true);
      safeUnsubscribe(() => ts.unsubscribeVisibleLogicalRangeChange(check));
    };
  }, [chart, !!control, control?.fillViewport, containerRef]);
  useEffect(() => { recheck.current?.(); }, [bundle, control?.hasMore, control?.loading, control?.blocked]);
}
