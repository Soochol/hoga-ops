/**
 * Segment + segment construction + time-formatting utilities.
 *
 * The Replay Viewer stitches multiple Stock-Dates onto a single virtual ms
 * axis (see CONTEXT.md "Virtual Axis"). The math for that axis (projections,
 * lookups, predicates, derived shapes) lives in `virtualAxis.ts` behind the
 * `VirtualAxis` factory; this module keeps only the `Segment` type, the
 * `buildSegments` constructor that `createVirtualAxis` calls internally, and
 * a handful of Segment-agnostic time-formatting utilities used elsewhere.
 *
 * - Real time = actual Unix milliseconds (UTC epoch).
 * - Virtual time = monotonic ms offset that skips inter-session gaps.
 */

export type Segment = {
  /** YYYYMMDD KST trading date. */
  date: string;
  /** Real Unix-ms of the session open (KST 09:00). */
  sessionOpenMs: number;
  /** Real Unix-ms of the session close (KST 15:30). */
  sessionCloseMs: number;
  /** Virtual axis ms where this segment begins. */
  virtualStart: number;
};

/**
 * Build segments from raw Stock-Date open/close pairs.
 *
 * Input is assumed to be sorted by date ascending. We walk in order and
 * accumulate `virtualStart` by stacking each session's real length onto the
 * previous segment's virtual end — collapsing the inter-session gap to zero.
 *
 * Production callers should construct a `VirtualAxis` via `createVirtualAxis`
 * (which calls this internally) rather than threading raw `Segment[]` arrays.
 */
export function buildSegments(
  raw: { date: string; sessionOpenMs: number; sessionCloseMs: number }[],
): Segment[] {
  const out: Segment[] = [];
  let cursor = 0;
  for (const r of raw) {
    out.push({
      date: r.date,
      sessionOpenMs: r.sessionOpenMs,
      sessionCloseMs: r.sessionCloseMs,
      virtualStart: cursor,
    });
    cursor += r.sessionCloseMs - r.sessionOpenMs;
  }
  return out;
}

/**
 * Sort by `time` ascending and dedupe so the output is strictly monotonic.
 * lightweight-charts asserts both conditions inside `setData`; the backend
 * does not currently guarantee either. When two items share a time, the
 * LATER one in the input wins — bucket-boundary collisions usually reflect
 * a late-arriving update that supersedes the earlier value.
 */
export function sortAndDedupeByTime<T extends { time: number }>(items: T[]): T[] {
  if (items.length <= 1) return items;
  const sorted = items.slice().sort((a, b) => a.time - b.time);
  const out: T[] = [];
  for (const item of sorted) {
    if (out.length === 0 || out[out.length - 1].time < item.time) {
      out.push(item);
    } else {
      out[out.length - 1] = item;
    }
  }
  return out;
}

/** Format a Unix-ms timestamp as HH:MM:SS in KST (UTC+9). */
export function unixMsToKSTClock(ms: number): string {
  const d = new Date(ms + 9 * 60 * 60 * 1000); // shift to KST
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/** Format milliseconds as M:SS or H:MM:SS. */
export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}
