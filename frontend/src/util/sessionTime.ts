/**
 * SessionTime — KRX session-time predicates as a single source.
 *
 * Domain language (CONTEXT.md):
 *   - **Pre-Open** — 08:30–09:00 KST. Auction-only book; not in the Regular
 *     Session. Backend candles may include these bars; chart projectors must
 *     drop them via `isRegularSession` / `axis.contains`.
 *   - **Regular Session** — `[sessionOpenMs, sessionCloseMs]` inclusive.
 *     Continuous trading + the Closing Auction band at the tail.
 *   - **Closing Auction Window** — last `AUCTION_WINDOW_LENGTH_MS` of the
 *     Regular Session. Length, not offset, is the invariant — half-day
 *     sessions (12:30 KST close) need the same 10-min band, just anchored
 *     to a shifted `sessionCloseMs`.
 *   - **Half-Day Session** — sessions where `sessionCloseMs - sessionOpenMs`
 *     is materially shorter than the typical 6h30m (year-end, lunar new
 *     year eve). Session bounds are always read per-Stock-Date from the
 *     parsed TSV (hoga/parser/__init__.py), never assumed.
 *   - **Gap** — inter-session region between two segments (post-close of
 *     segment N, pre-open of segment N+1).
 *   - **Pre-Axis / Post-Axis** — `realMs` before the first segment opens or
 *     after the final segment closes.
 *
 * Why a dedicated module: these predicates were previously expressed as
 * ad-hoc inequalities scattered across projectors and `virtualAxis`. The
 * historical bugs (MA pre-open contamination, half-day auction window
 * disabled, ratio masking with no visual cue) all surfaced because the
 * domain rules lived in too many places. `sessionPhaseAt` is the single
 * function every consumer should route through; the legacy
 * `axis.contains` / `axis.inClosingAuctionWindow` helpers delegate here.
 */

export type SessionPhase = 'pre-open' | 'regular' | 'auction' | 'gap' | 'pre-axis' | 'post-axis';

export interface SessionSegment {
  sessionOpenMs: number;
  sessionCloseMs: number;
}

/**
 * Last N minutes of every Regular Session, regardless of session length — the
 * single source of the Closing Auction Window length. Anchored to
 * `sessionCloseMs` by length (not a fixed offset from open), so half-day
 * sessions inherit the same 10-min band. Overlays and predicates import this
 * constant rather than re-spelling the literal.
 */
export const AUCTION_WINDOW_LENGTH_MS = 10 * 60 * 1000;

/**
 * Pre-Open auction runs from 08:30 KST until session open. Encoded as a
 * duration so half-day sessions inherit the same 30-minute pre-open band
 * without re-deriving wall-clock anchors.
 */
export const PRE_OPEN_WINDOW_LENGTH_MS = 30 * 60 * 1000;

/**
 * Classify `realMs` relative to a single segment.
 *
 * Returns `'pre-axis'` for any timestamp before this segment's pre-open band.
 * Use `sessionPhaseAt(segments, realMs)` when scanning across multiple
 * segments — that helper picks the owning segment first.
 */
export function classifyWithinSegment(seg: SessionSegment, realMs: number): SessionPhase {
  const preOpenStart = seg.sessionOpenMs - PRE_OPEN_WINDOW_LENGTH_MS;
  if (realMs < preOpenStart) return 'pre-axis';
  if (realMs < seg.sessionOpenMs) return 'pre-open';
  if (realMs > seg.sessionCloseMs) return 'post-axis';
  const auctionStart = seg.sessionCloseMs - AUCTION_WINDOW_LENGTH_MS;
  return realMs >= auctionStart ? 'auction' : 'regular';
}

/** Last index whose pre-open band start (`sessionOpenMs - PRE_OPEN_WINDOW_LENGTH_MS`)
 *  is ≤ realMs. -1 when realMs precedes the first segment's pre-open band.
 *  Equivalent to `sessionOpenMs ≤ realMs + PRE_OPEN_WINDOW_LENGTH_MS`. */
function lowerBoundOwning(segments: readonly SessionSegment[], realMs: number): number {
  const key = realMs + PRE_OPEN_WINDOW_LENGTH_MS;
  let lo = 0;
  let hi = segments.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (segments[mid].sessionOpenMs <= key) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

export interface SegmentLocation {
  /** Owning/candidate segment index, or -1 when realMs is pre-axis. */
  idx: number;
  phase: SessionPhase;
}

/**
 * Binary-search variant of phase classification. Returns both the owning
 * segment index (for callers that also need the segment, e.g. virtual-coord
 * projection) and the phase. Owning segment = last whose pre-open band has
 * started. Assumes inter-session gaps exceed PRE_OPEN_WINDOW_LENGTH_MS (true
 * for daily KRX sessions); the prior linear implementation made the same
 * assumption.
 */
export function locateSegment(
  segments: readonly SessionSegment[],
  realMs: number,
): SegmentLocation {
  if (segments.length === 0) return { idx: -1, phase: 'pre-axis' };
  const idx = lowerBoundOwning(segments, realMs);
  if (idx < 0) return { idx: -1, phase: 'pre-axis' };
  const seg = segments[idx];
  if (realMs <= seg.sessionCloseMs) {
    return { idx, phase: classifyWithinSegment(seg, realMs) };
  }
  // Past this segment's close: gap if another segment follows, else post-axis.
  return { idx, phase: idx === segments.length - 1 ? 'post-axis' : 'gap' };
}

/**
 * Classify `realMs` across an ordered array of segments. Inputs MUST be sorted
 * by `sessionOpenMs` ascending (the same invariant `buildSegments` enforces).
 *
 * Returns:
 *   - `'pre-axis'` — realMs before the first segment's pre-open band
 *   - `'post-axis'` — realMs after the final segment closes
 *   - `'gap'` — realMs in an inter-session gap between two segments
 *   - `'pre-open'` / `'regular'` / `'auction'` — within a segment
 */
export function sessionPhaseAt(segments: readonly SessionSegment[], realMs: number): SessionPhase {
  return locateSegment(segments, realMs).phase;
}

/**
 * True if `realMs` is inside the Regular Session (continuous trading + the
 * Closing Auction band) of some segment. Equivalent to the legacy
 * `axis.contains` predicate; preserved as a named helper so projectors can
 * read at call sites as "is this a session bar?".
 */
export function isRegularSession(segments: readonly SessionSegment[], realMs: number): boolean {
  const phase = sessionPhaseAt(segments, realMs);
  return phase === 'regular' || phase === 'auction';
}

/**
 * True if `realMs` is inside the Closing Auction Window. Equivalent to the
 * legacy `axis.inClosingAuctionWindow`. Half-day sessions are handled
 * automatically because the band is anchored to `sessionCloseMs`, not to a
 * fixed offset from `sessionOpenMs`.
 */
export function isClosingAuction(segments: readonly SessionSegment[], realMs: number): boolean {
  return sessionPhaseAt(segments, realMs) === 'auction';
}

/**
 * True if `realMs` is inside the Pre-Open Auction (08:30–09:00 KST on a
 * full-day session). Most projectors don't currently consume this — they
 * just need `isRegularSession` to exclude pre-open bars — but exposing it
 * keeps the domain enum complete and gives future overlays a place to hook.
 */
export function isPreOpen(segments: readonly SessionSegment[], realMs: number): boolean {
  return sessionPhaseAt(segments, realMs) === 'pre-open';
}
