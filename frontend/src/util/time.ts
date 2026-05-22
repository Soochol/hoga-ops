/**
 * Compressed virtual time axis math for the replay viewer.
 *
 * Hoga-ops stitches multiple Stock-Dates onto a single, apparently-continuous
 * timeline. The gaps between trading sessions (15:30 close → 09:00 next-day
 * open) are compressed away so the user sees one smooth axis.
 *
 * - Real time = actual Unix milliseconds (UTC epoch).
 * - Virtual time = monotonic ms offset that skips inter-session gaps.
 *
 * See spec §6.3 + the frontend plan (Task 6.1).
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
 * Virtual end of a segment (virtualStart + session length).
 */
function virtualEnd(seg: Segment): number {
  return seg.virtualStart + (seg.sessionCloseMs - seg.sessionOpenMs);
}

/**
 * Real Unix-ms → virtual axis ms.
 *
 * Edge-case decisions:
 *  - Empty segments → 0 (no axis exists yet; safe sentinel for renderers).
 *  - realMs before the first segment's open → 0.
 *  - realMs inside a session → virtualStart + (realMs - sessionOpenMs).
 *  - realMs inside a between-day gap → snaps forward to the next segment's
 *    virtualStart. Choosing "next" matches the viewer behavior where the
 *    grey gap band is non-interactive and the cursor lands on the next open.
 *  - realMs after the final close → the final segment's virtual end.
 *  - Pre-session times collapse to virtualStart=0. CALLERS THAT PRODUCE
 *    SERIES DATA MUST PRE-FILTER WITH `isWithinSessions` — otherwise two
 *    pre-session points produce duplicate virtual-time=0 entries and
 *    lightweight-charts' setData throws.
 */
export function realToVirtual(segments: Segment[], realMs: number): number {
  if (segments.length === 0) return 0;
  const first = segments[0];
  if (realMs <= first.sessionOpenMs) return first.virtualStart; // == 0 by construction
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (realMs >= seg.sessionOpenMs && realMs <= seg.sessionCloseMs) {
      // Inside this session.
      return seg.virtualStart + (realMs - seg.sessionOpenMs);
    }
    if (realMs > seg.sessionCloseMs) {
      const next = segments[i + 1];
      if (next && realMs < next.sessionOpenMs) {
        // In the gap between seg and next → snap to next open.
        return next.virtualStart;
      }
      // Otherwise keep scanning; if no next, we're past the last close.
      if (!next) return virtualEnd(seg);
    }
  }
  // Shouldn't reach here, but guard anyway: clamp to final virtual end.
  return virtualEnd(segments[segments.length - 1]);
}

/**
 * Virtual axis ms → real Unix-ms.
 *
 * Edge-case decisions:
 *  - Empty segments → 0.
 *  - virtualMs < 0 → clamped to first segment's sessionOpenMs.
 *  - virtualMs exactly at a segment boundary (== next.virtualStart) maps to
 *    next.sessionOpenMs (the "next" segment owns its starting boundary).
 *  - virtualMs past the last segment's virtual end → last segment's
 *    sessionCloseMs (clamped).
 */
export function virtualToReal(segments: Segment[], virtualMs: number): number {
  if (segments.length === 0) return 0;
  if (virtualMs <= 0) return segments[0].sessionOpenMs;

  const idx = findSegmentByVirtual(segments, virtualMs);
  if (idx < 0) return segments[0].sessionOpenMs;

  const seg = segments[idx];
  const offset = virtualMs - seg.virtualStart;
  const sessionLen = seg.sessionCloseMs - seg.sessionOpenMs;
  if (offset >= sessionLen) {
    // At/past this segment's virtual end. If a next segment exists and we are
    // exactly at its virtualStart, prefer mapping to next.sessionOpenMs.
    const next = segments[idx + 1];
    if (next && virtualMs >= next.virtualStart) return next.sessionOpenMs;
    return seg.sessionCloseMs;
  }
  return seg.sessionOpenMs + offset;
}

/**
 * Binary search for the segment whose [virtualStart, virtualEnd] range contains
 * virtualMs. If virtualMs sits exactly on a boundary, the *later* segment owns
 * it (so a query at next.virtualStart returns the next index, not the prior
 * one's end).
 *
 * Returns -1 if virtualMs < segments[0].virtualStart.
 */
export function findSegmentByVirtual(segments: Segment[], virtualMs: number): number {
  if (segments.length === 0) return -1;
  if (virtualMs < segments[0].virtualStart) return -1;

  let lo = 0;
  let hi = segments.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (segments[mid].virtualStart <= virtualMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * True if realMs falls inside ANY segment's [sessionOpenMs, sessionCloseMs]
 * (inclusive on both ends). Used by chart panes to filter out pre-open auction
 * candles (8:30–9:00 KST) and post-close points before mapping through
 * `realToVirtual`. Without this guard, those points collapse to virtual time
 * 0 and lightweight-charts throws "data must be asc ordered by time" on the
 * second clamped point.
 *
 * Returns false for empty segments.
 */
export function isWithinSessions(segments: Segment[], realMs: number): boolean {
  for (const seg of segments) {
    if (realMs >= seg.sessionOpenMs && realMs <= seg.sessionCloseMs) return true;
  }
  return false;
}

/**
 * Sort by `time` ascending and dedupe so the output is strictly monotonic.
 * lightweight-charts asserts both conditions inside `setData`; the backend
 * does not currently guarantee either (quote_ratio.points carry duplicate
 * timestamps at bucket boundaries, fill_strength.points are concatenated
 * from multiple segments without re-sorting). When two items share a time,
 * the LATER one in the input wins — bucket-boundary collisions usually
 * reflect a late-arriving update that supersedes the earlier value.
 *
 * Safe for series outputs (already mapped to virtual axis seconds). Cost
 * is O(n log n); for the largest series we see (~20k quote_ratio points)
 * this is still sub-millisecond on modern hardware.
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

/**
 * True if realMs falls in the gap between two adjacent segments, OR after the
 * last segment's close. Useful for drawing grey "non-session" bands on the
 * chart and for disabling interaction in those regions.
 *
 * Returns false if there are no segments, or if realMs is before the first
 * open (that's a "pre-axis" region, not a gap between sessions).
 */
export function isDayBoundary(segments: Segment[], realMs: number): boolean {
  if (segments.length === 0) return false;
  if (realMs < segments[0].sessionOpenMs) return false;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (realMs >= seg.sessionOpenMs && realMs <= seg.sessionCloseMs) {
      return false;
    }
    if (realMs > seg.sessionCloseMs) {
      const next = segments[i + 1];
      if (!next) return true; // past final close
      if (realMs < next.sessionOpenMs) return true; // in inter-session gap
    }
  }
  return false;
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
