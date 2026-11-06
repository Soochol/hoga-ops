import { useCallback, useEffect, useRef, useState } from 'react';
import { type UTCTimestamp, type IChartApi } from 'lightweight-charts';
import { useLivePastDailyCandles } from '../api/livePastDailyCandles';
import { useScreenerDailyCandles } from '../api/screenerDailyCandles';
import { canReceiveTimeframeJump, type CalendarJumpSource, type JumpReceiver } from '../chart/timeframeJump';
import { isCalendarTimeframe } from '../state/livePage';
import type { VirtualAxis } from '../util/virtualAxis';
import { useLiveCursorStore } from './useLiveCursorStore';
import { calendarPeriodStart, calendarQueryStatus, exactCalendarTarget, lastObservedDailyDate,
  type CalendarQueryStatus } from './calendarJump';
import { realMsToVirtualSeconds } from './viewportAnchor';

function isChartTimestamp(value: number): value is UTCTimestamp {
  return Number.isFinite(value);
}

export type CalendarJumpState = {
  date: string;
  status: 'seeking-daily' | 'seeking-target' | 'landed' | 'no-data' | 'failed' | 'out-of-range' | 'cancelled';
};
type Token = { seq: number; source: CalendarJumpSource; identity: string; viewKey: string; revision: number; cold: boolean };
type Geometry = { span: number; padding: number };
type ReceiverState =
  | { kind: 'idle' }
  | { kind: 'seeking-daily'; token: Token; geometry: Geometry | null }
  | { kind: 'seeking-target'; token: Token; geometry: Geometry | null; date: string }
  | { kind: 'landed' | 'no-data' | 'failed' | 'out-of-range' | 'cancelled'; token: Token; date: string };

export function useCalendarJumpReceiver(args: {
  target: JumpReceiver;
  identity: string;
  viewKey: string;
  inputRevision: number;
  chart: IChartApi | null;
  axis: VirtualAxis;
  candles: readonly { ts_ms: number }[];
  ready: boolean;
  queryStatus: CalendarQueryStatus | null;
  extend: (date: string) => void;
}) {
  const request = useLiveCursorStore(s => s.jumpRequest);
  const lastObservedSeq = useRef(useLiveCursorStore.getState().jumpRequest?.seq ?? 0);
  const [state, setState] = useState<ReceiverState>({ kind: 'idle' });
  const claim = useRef({ viewKey: args.viewKey, owned: false });
  if (claim.current.viewKey !== args.viewKey) claim.current = { viewKey: args.viewKey, owned: false };
  const isNewRequest = request !== null && request.seq > lastObservedSeq.current;
  if (isNewRequest) {
    lastObservedSeq.current = request.seq;
    const source = request.calendarSource;
    setState(source && isCalendarTimeframe(args.target.timeframe) && canReceiveTimeframeJump({
      origin: request.origin, sourceStockCode: source.code, target: args.target, allowCrossSymbol: false,
    }) ? { kind: 'seeking-daily', token: { seq: request.seq, source, identity: args.identity,
      viewKey: args.viewKey, revision: args.inputRevision, cold: !args.ready || args.candles.length === 0 }, geometry: null } : { kind: 'idle' });
  }
  const sameCommand = state.kind !== 'idle' && state.token.seq === request?.seq
    && state.token.source.sourceKey === request.calendarSource?.sourceKey
    && state.token.identity === args.identity && state.token.viewKey === args.viewKey;
  const valid = sameCommand && state.token.revision === args.inputRevision;
  if (!isNewRequest && state.kind !== 'idle' && state.kind !== 'cancelled' && (!sameCommand
    || ((state.kind === 'seeking-daily' || state.kind === 'seeking-target') && !valid))) {
    setState({ kind: 'cancelled', token: state.token, date: 'date' in state ? state.date : state.token.source.to });
  }
  const pending = valid && (state.kind === 'seeking-daily' || state.kind === 'seeking-target') ? state : null;
  const source = pending?.kind === 'seeking-daily' && pending.token.source.from <= pending.token.source.to
    ? pending.token.source : null;
  const vendor = useLivePastDailyCandles(source?.source === 'vendor' ? source.code : null,
    source?.from ?? null, source?.to ?? null, source?.venue ?? 'KRX', 'D');
  const disk = useScreenerDailyCandles(source?.source === 'disk' ? source.code : null,
    source?.from ?? null, source?.to ?? null);
  const daily = source?.source === 'disk' ? disk : vendor;
  const dailyStatus = source ? calendarQueryStatus({
    identity: { ...source, timeframe: 'D' }, data: daily.data,
    isPlaceholderData: daily.isPlaceholderData, isPending: daily.isPending, error: daily.error,
  }) : null;
  const latest = useRef({ args, state, valid });
  latest.current = { args, state, valid };
  const extended = useRef<Token | null>(null);

  useEffect(() => {
    if (!pending) return;
    const token = pending.token;
    const finish = (kind: 'no-data' | 'failed' | 'out-of-range') => {
      setState(current => current.kind !== 'idle' && current.token === token
        ? { kind, token, date: 'date' in pending ? pending.date : token.source.to } : current);
    };
    if (pending.kind === 'seeking-daily') {
      if (token.source.from > token.source.to) { finish('out-of-range'); return; }
      if (dailyStatus?.kind === 'failed') { finish('failed'); return; }
      if (dailyStatus?.kind === 'ready') {
        const date = lastObservedDailyDate(token.source, daily.data?.candles ?? []);
        if (date === null) { finish('no-data'); return; }
        setState(current => current.kind === 'seeking-daily' && current.token === token
          ? { ...current, kind: 'seeking-target', date } : current);
      }
    } else {
      const status = args.queryStatus;
      if (status?.kind === 'failed') { finish('failed'); return; }
      if (status?.kind === 'ready' && status.to < pending.date) { finish('out-of-range'); return; }
      const tf = args.target.timeframe;
      if (isCalendarTimeframe(tf) && status?.kind === 'ready') {
        const targetMs = exactCalendarTarget(args.candles, pending.date, tf);
        const start = calendarPeriodStart(Date.UTC(Number(pending.date.slice(0, 4)),
          Number(pending.date.slice(4, 6)) - 1, Number(pending.date.slice(6, 8))), tf);
        if (targetMs === null && status.from <= start) { finish('no-data'); return; }
        if (targetMs === null && (pending.geometry !== null || args.candles.length === 0) && extended.current !== token) {
          extended.current = token;
          args.extend(start);
        }
      }
    }
  }, [pending, dailyStatus?.kind, daily.data, args.queryStatus, args.candles, args.target.timeframe, args.extend]);

  useEffect(() => {
    if (!pending || !args.ready || !args.chart || args.candles.length === 0 || pending.geometry !== null) return;
    let raf = 0;
    const capture = () => {
      const current = latest.current;
      if (!current.valid || current.state !== pending) return;
      const { chart, axis, candles } = current.args;
      if (!chart) return;
      const last = candles.at(-1);
      const time = last && axis.contains(last.ts_ms) ? realMsToVirtualSeconds(axis, last.ts_ms) : NaN;
      const ts = chart.timeScale();
      const index = isChartTimestamp(time) ? ts.timeToIndex(time, false) : null;
      const range = ts.getVisibleLogicalRange();
      if (index === null || !range || !Number.isFinite(index) || !(range.to > range.from)) {
        raf = requestAnimationFrame(capture);
        return;
      }
      claim.current.owned = true;
      const geometry = { span: range.to - range.from, padding: Math.max(0, range.to - (index + 1)) };
      setState(previous => (previous.kind === 'seeking-daily' || previous.kind === 'seeking-target')
        && previous.token === pending.token ? { ...previous, geometry } : previous);
    };
    if (pending.token.cold) raf = requestAnimationFrame(() => { raf = requestAnimationFrame(capture); });
    else capture();
    return () => cancelAnimationFrame(raf);
  }, [pending, args.ready, args.chart, args.axis, args.candles, args.viewKey]);

  useEffect(() => {
    if (pending?.kind !== 'seeking-target' || !pending.geometry || args.queryStatus?.kind !== 'ready'
      || !args.chart || !isCalendarTimeframe(args.target.timeframe)) return;
    const targetMs = exactCalendarTarget(args.candles, pending.date, args.target.timeframe);
    if (targetMs === null) return;
    let raf = 0;
    const place = () => {
      const current = latest.current;
      if (!current.valid || current.state !== pending || current.args.chart !== args.chart) return;
      const { chart, axis } = current.args;
      if (!chart) return;
      const time = axis.contains(targetMs) ? realMsToVirtualSeconds(axis, targetMs) : NaN;
      const ts = chart.timeScale();
      const index = isChartTimestamp(time) ? ts.timeToIndex(time, false) : null;
      if (index === null || !Number.isFinite(index)) {
        raf = requestAnimationFrame(place);
        return;
      }
      const geometry = pending.geometry;
      if (!geometry) return;
      const to = index + 1 + geometry.padding;
      try {
        ts.setVisibleLogicalRange({ from: to - geometry.span, to });
        setState({ kind: 'landed', token: pending.token, date: pending.date });
      } catch {
        setState({ kind: 'failed', token: pending.token, date: pending.date });
      }
    };
    raf = requestAnimationFrame(() => { raf = requestAnimationFrame(place); });
    return () => cancelAnimationFrame(raf);
  }, [pending, args.chart, args.axis, args.candles, args.queryStatus?.kind, args.target.timeframe]);

  const clear = useCallback(() => setState({ kind: 'idle' }), []);
  const visible = state.kind !== 'idle' && state.token.identity === args.identity
    && state.token.viewKey === args.viewKey && state.token.source.sourceKey === request?.calendarSource?.sourceKey;
  const chip: CalendarJumpState | null = visible
    ? { status: state.kind, date: 'date' in state ? state.date : state.token.source.to } : null;
  return { state: chip, clear, hasPlacementClaim: claim.current.owned };
}
