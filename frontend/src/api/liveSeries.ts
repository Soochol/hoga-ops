import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiCall } from './client';
import { subscribeLive } from './ws';
import type { LiveSnapshotEntry } from './types';
import { LiveSnapshotBuffer, type SnapshotKind } from '../live/liveSnapshotBuffer';
import type { ObSnapshot, TradeSnapshot } from '../live/bucketHogaSeries';
import { unixMsToKSTDate } from '../util/time';

export interface LiveSeriesResponse {
  code: string;
  date: string;
  session_open_ms: number;
  session_close_ms: number | null;
  is_open: boolean;
  snapshots: Array<Record<string, unknown>>;
  trades: Array<Record<string, unknown>>;
  brokers: Array<Record<string, unknown>>;
}

/** Return shape of useLiveSeries. Lifted to a named type so the single-call
 * site (LivePage) can thread the value through useLiveBundle + LiveSidebar
 * as a prop. Two separate useLiveSeries calls would open two WebSocket subscriptions
 * and two independent buffers — HMR re-mounts cleared one but not the other,
 * leaving the sidebar's LATEST mode showing the empty-buffer state. */
export interface LiveSeriesData {
  initial: LiveSeriesResponse | undefined;
  isLoading: boolean;
  error: unknown;
  // ob/trade are narrowed to the shapes their consumers read (SR-1). The SSE
  // entries genuinely carry these fields (the poller's typed builders write
  // them); ObSnapshot/TradeSnapshot keep an index signature so the buffer's
  // structurally-untyped rows assign without an `as unknown as` double cast.
  ob: ReadonlyArray<ObSnapshot>;
  trade: ReadonlyArray<TradeSnapshot>;
  broker: ReadonlyArray<Record<string, unknown>>;
}

/**
 * useLiveSeries — initial REST fetch + WebSocket subscription for live snapshots.
 *
 * - Initial fetch: GET /api/live/series → hydrates the in-memory buffer with
 *   anything already in the backend's ring buffer (e.g. session-to-date).
 * - WebSocket: subscribes via ws.ts (ADR-0053) and appends each live snapshot
 *   from the ws.ts live channel ({ch:'live', code, data}) to the buffer.
 * - Buffer cap: `LiveSnapshotBuffer` caps each kind at MAX_BUFFER_PER_KIND
 *   (Eng C5) so the page can run all day without unbounded growth.
 *
 * Returns parallel arrays per kind plus the initial response metadata so
 * panes can compute session bounds for chart timeframes.
 */
export function useLiveSeries(code: string): LiveSeriesData {
  const date = unixMsToKSTDate(Date.now());
  const initial = useQuery({
    queryKey: ['live', 'series', code, date],
    queryFn: () =>
      apiCall<LiveSeriesResponse>(
        `/api/live/series?code=${encodeURIComponent(code)}&date=${date}`,
      ),
    enabled: !!code,
    staleTime: 60_000,
  });

  const bufferRef = useRef(new LiveSnapshotBuffer());
  const [tick, setTick] = useState(0); // bump to re-read buffer

  // Hydrate buffer when initial fetch completes.
  useEffect(() => {
    if (!initial.data) return;
    bufferRef.current.hydrate({
      ob: initial.data.snapshots as Array<{ t_ms: number; kind: string }>,
      trade: initial.data.trades as Array<{ t_ms: number; kind: string }>,
      broker: initial.data.brokers as Array<{ t_ms: number; kind: string }>,
    });
    setTick((t) => t + 1);
  }, [initial.data]);

  // Subscribe to live snapshots over the shared WebSocket (ADR-0053). Buffer +
  // rAF coalescing stay tab-side; only the transport changed.
  useEffect(() => {
    if (!code) return;
    let rafId: number | null = null;
    const flush = () => { rafId = null; setTick((t) => t + 1); };
    const unsub = subscribeLive(code, (entry: LiveSnapshotEntry) => {
      bufferRef.current.push(entry);
      if (rafId === null) rafId = requestAnimationFrame(flush);
    });
    return () => {
      unsub();
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
      bufferRef.current.clear();
      setTick(0);
    };
  }, [code]);

  // `tick` is intentionally passed to readKind so that React re-reads the
  // buffer on every WS push — bump state forces a re-render, readKind then
  // sees the updated buffer contents.
  return {
    initial: initial.data,
    isLoading: initial.isLoading,
    error: initial.error,
    // One structural cast at the buffer boundary: the buffer stores raw
    // {t_ms, kind, ...payload} dicts; the 'ob'/'trade' kinds carry the
    // ObSnapshot/TradeSnapshot fields the poller's typed builders wrote.
    ob: readKind(bufferRef.current, 'ob', tick) as ReadonlyArray<ObSnapshot>,
    trade: readKind(bufferRef.current, 'trade', tick) as ReadonlyArray<TradeSnapshot>,
    broker: readKind(bufferRef.current, 'broker', tick),
  };
}

// `tick` is ignored at runtime but referenced so React tracks the dep.
// Returns a readonly, stable-reference snapshot (see LiveSnapshotBuffer.get).
function readKind(
  buf: LiveSnapshotBuffer,
  kind: SnapshotKind,
  _tick: number,
): ReadonlyArray<Record<string, unknown>> {
  return buf.get(kind);
}
