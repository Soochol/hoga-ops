import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiCall, apiUrl } from './client';
import { LiveSnapshotBuffer, type SnapshotKind } from '../live/liveSnapshotBuffer';

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

function todayKstYyyymmdd(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3_600_000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(kst.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/**
 * useLiveSeries — initial REST fetch + SSE subscription for live snapshots.
 *
 * - Initial fetch: GET /api/live/series → hydrates the in-memory buffer with
 *   anything already in the backend's ring buffer (e.g. session-to-date).
 * - SSE: subscribes to /api/live/stream and appends each event to the buffer.
 * - Buffer cap: `LiveSnapshotBuffer` caps each kind at MAX_BUFFER_PER_KIND
 *   (Eng C5) so the page can run all day without unbounded growth.
 *
 * Returns parallel arrays per kind plus the initial response metadata so
 * panes can compute session bounds for chart timeframes.
 */
export function useLiveSeries(code: string) {
  const date = todayKstYyyymmdd();
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

  // Subscribe to SSE. The URL must go through apiUrl() so that frontend dev
  // server (vite, 5173) doesn't intercept it; backend lives on a different
  // origin in dev (8000) and apiUrl resolves that from config.
  useEffect(() => {
    if (!code) return;
    let es: EventSource | null = null;
    let cancelled = false;
    // Coalesce SSE bursts into one re-render per animation frame. The backend
    // poller (cycle_seconds=10s) flushes N snapshots at once; without this,
    // each message triggered its own setTick → React render → bundle recompute,
    // which produced ~1s long tasks every 10s on /live.
    let rafId: number | null = null;
    const flush = () => {
      rafId = null;
      setTick((t) => t + 1);
    };
    apiUrl(`/api/live/stream?code=${encodeURIComponent(code)}`).then((url: string) => {
      if (cancelled) return;
      es = new EventSource(url);
      es.onmessage = (e: MessageEvent) => {
        try {
          const entry = JSON.parse(e.data) as { t_ms: number; kind: string };
          bufferRef.current.push(entry);
          if (rafId === null) rafId = requestAnimationFrame(flush);
        } catch {
          // Malformed SSE message — skip silently.
        }
      };
    });
    return () => {
      cancelled = true;
      es?.close();
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      bufferRef.current.clear();
      setTick(0);
    };
  }, [code]);

  // `tick` is intentionally passed to readKind so that React re-reads the
  // buffer on every SSE push — bump state forces a re-render, readKind then
  // sees the updated buffer contents.
  return {
    initial: initial.data,
    isLoading: initial.isLoading,
    error: initial.error,
    ob: readKind(bufferRef.current, 'ob', tick),
    trade: readKind(bufferRef.current, 'trade', tick),
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
