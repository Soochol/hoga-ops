/**
 * Virtual Axis — the deepened module that owns multi-day time stitching for the
 * replay viewer.
 *
 * Hoga-ops splices several Stock-Dates onto one apparently-continuous timeline.
 * The gaps between trading sessions (15:30 close → 09:00 next-day open) are
 * compressed away — minus a 1-second `INTER_SEGMENT_GAP_MS` (see `util/time.ts`)
 * that keeps day N's closing candle and day N+1's opening candle on distinct
 * virtual timestamps. The gap is too small to perceive but large enough to
 * survive the `/1000` rounding into lightweight-charts' integer-second
 * `UTCTimestamp`. The math used to live as a bag of free functions in
 * `util/time.ts`; this module promotes the bag to a first-class `VirtualAxis`
 * value object with frozen state and short method names. Construction goes
 * through `createVirtualAxis(rawSegments)`.
 *
 * Decisions captured in `docs/adr/` from the `/improve-codebase-architecture`
 * grilling (G1-G4):
 *   - G1: "Virtual Axis" is the canonical CONTEXT.md domain term.
 *   - G2: factory + frozen object (matches the codebase's functional convention
 *     and plays nicely with `useMemo` consumers).
 *   - G3: short method names — `toVirtual` / `toReal` / `findByReal` /
 *     `contains` / `isInGap`. The `axis.` prefix already supplies the
 *     "virtual" qualifier.
 *   - G4: `axis.segments` stays read-only (one-off escape hatches still need
 *     it), and `axis.dayBoundaries` is derived once so consumers stop
 *     repeating `segments.slice(1).map(...)`.
 *
 * - Real time = actual Unix milliseconds (UTC epoch).
 * - Virtual time = monotonic ms offset that skips inter-session gaps.
 */

import { buildSegments, type Segment } from './time';
import { isClosingAuction, isRegularSession, locateSegment } from './sessionTime';

export type DayBoundary = Readonly<{
  /** YYYYMMDD KST trading date of the segment that opens at this boundary. */
  date: string;
  /** Virtual-ms offset of the boundary (= virtualStart of the next segment). */
  virtualStart: number;
}>;

export type VirtualAxis = Readonly<{
  /** Frozen list of stitched segments, ordered by date ascending. */
  segments: readonly Segment[];
  /**
   * Frozen list of N-1 boundaries derived from `segments`. Empty when there
   * are fewer than two segments. Each entry mirrors the `Segment` that opens
   * the boundary, exposing only the two fields callers need.
   */
  dayBoundaries: readonly DayBoundary[];
  /** Real Unix-ms → virtual axis ms. See `realToVirtual` in `util/time.ts`. */
  toVirtual(realMs: number): number;
  /** Virtual axis ms → real Unix-ms. See `virtualToReal` in `util/time.ts`. */
  toReal(virtualMs: number): number;
  /**
   * Binary search for the segment containing realMs (or the prior segment if
   * realMs falls in a gap). Returns -1 for empty axis or pre-axis realMs.
   * See `findSegmentByReal` in `util/time.ts`.
   */
  findByReal(realMs: number): number;
  /**
   * Binary search for the segment containing virtualMs. Returns -1 for empty
   * axis or pre-axis virtualMs. See `findSegmentByVirtual` in `util/time.ts`.
   */
  findByVirtual(virtualMs: number): number;
  /**
   * True if realMs falls inside ANY segment's [sessionOpenMs, sessionCloseMs]
   * (inclusive). See `isWithinSessions` in `util/time.ts`.
   */
  contains(realMs: number): boolean;
  /**
   * True if realMs falls in an inter-session gap or after the final close.
   * False for pre-axis realMs. See `isDayBoundary` in `util/time.ts`.
   */
  isInGap(realMs: number): boolean;
  /**
   * True if realMs falls inside its owning segment's **Closing Auction Window**
   * — the last `AUCTION_WINDOW_LENGTH_MS` (10 min) of the Regular Session,
   * `[sessionCloseMs - 10min, sessionCloseMs]` (15:20–15:30 KST on a full-day
   * session). The band is anchored to `sessionCloseMs` by *length*, not a fixed
   * offset from open, so half-day sessions (e.g. 12:30 close) get the same
   * 10-min band shifted with the early close (see `sessionTime.isClosingAuction`).
   * False for realMs outside any segment or anywhere in the pre-axis / gap /
   * post-axis regions. Mirrors the CONTEXT.md "Auction Window" entry. Used by
   * panes that suppress derived metrics (e.g. RatioPane masks 호가비 to 0;
   * CandlePane mutes candle colors) during the band where one-sided order
   * accumulation makes data non-informative.
   */
  inClosingAuctionWindow(realMs: number): boolean;
  /**
   * Single-lookup projection for the candle hot path: one `locateSegment`
   * binary search yields all three of `contains` / `inClosingAuctionWindow` /
   * `toVirtual` for `realMs`. `virtual` is meaningful only when `contained`
   * is true (dropped candles never read it). Equivalent to calling the three
   * methods separately — see virtualAxis.test.ts equivalence test.
   */
  classifyAndProject(realMs: number): { contained: boolean; inAuction: boolean; virtual: number };
}>;

/**
 * Construct a `VirtualAxis` from raw session open/close pairs. The input is
 * assumed to be sorted by date ascending; the internal `buildSegments` walks
 * in order and accumulates `virtualStart` by stacking session lengths onto the
 * previous virtual end — collapsing inter-session gaps to zero.
 *
 * `originMs` (default 0) anchors segments[0].virtualStart. /live passes the
 * first session's REAL open ms ("real-anchored origin") to defeat a
 * lightweight-charts staleness trap: lwc identifies time-scale points by
 * their time VALUE across setData generations — points whose times match the
 * previous data keep their old `timeWeight`s, tick marks before the first
 * changed index are retained, and formatted tick labels are cached by
 * (weight, time) via the behavior's `cacheKey`. A zero-based axis re-issues
 * the SAME virtual times (the uniform n×23401s ladder for D/W/M; a
 * value-identical prefix for prepends) for DIFFERENT real dates whenever the
 * axis remaps, so the x-axis kept rendering the previous generation's dates
 * on the unchanged prefix — old region wrong, recent region fine.
 *
 * Scope of the guarantee: WITHIN one (code, timeframe) view, the time at
 * index 0 changes whenever segments[0] moves (leftward-pan prepend) → lwc
 * sees firstChangedPointIndex=0 → full weight/mark/label rebuild; right-edge
 * SSE appends keep the origin → incremental update as before. ACROSS views
 * the origin is NOT a sufficient discriminator — two views can share
 * segments[0] yet differ in interior dates (W↔M windows clamped to the same
 * first trading day; per-stock missing dates under gap compression) — so
 * /live recreates the chart instance per (code, timeframe) instead
 * (LiveChartRoot's per-viewKey effect), and the KST behavior's `cacheKey`
 * folds an axis generation into label-cache keys for cross-generation value
 * collisions at different indices. The zero-based default stays for callers
 * with no regeneration-collision class: /live's pre-data EMPTY_AXIS, the
 * projector/unit tests, and any future viewer that mounts ONE static axis
 * per lifetime (the deleted replay viewer's shape).
 *
 * The returned object and its `segments` / `dayBoundaries` arrays are
 * `Object.freeze`-d so consumers cannot mutate axis state by accident.
 */
export function createVirtualAxis(
  rawSegments: Array<{ date: string; sessionOpenMs: number; sessionCloseMs: number }>,
  originMs = 0,
): VirtualAxis {
  const segments = Object.freeze(buildSegments(rawSegments, originMs));
  const dayBoundaries = Object.freeze(
    segments.slice(1).map<DayBoundary>((seg) =>
      Object.freeze({ date: seg.date, virtualStart: seg.virtualStart }),
    ),
  );

  const virtualEnd = (seg: Segment): number =>
    seg.virtualStart + (seg.sessionCloseMs - seg.sessionOpenMs);

  function findByVirtual(virtualMs: number): number {
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

  function findByReal(realMs: number): number {
    if (segments.length === 0) return -1;
    if (realMs < segments[0].sessionOpenMs) return -1;
    let lo = 0;
    let hi = segments.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (segments[mid].sessionOpenMs <= realMs) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }

  /**
   * Edge-case decisions (mirror the legacy free functions in `util/time.ts`):
   *  - Empty axis → 0 (safe sentinel for renderers).
   *  - realMs before the first open → first.virtualStart (== originMs).
   *  - realMs inside a session → virtualStart + (realMs - sessionOpenMs).
   *  - realMs inside a between-day gap → snaps forward to the next segment's
   *    virtualStart (the gap is non-interactive; the cursor lands on next open).
   *  - realMs after the final close → final segment's virtual end.
   *
   * Binary search via findByReal — this is the per-point hot path (every
   * projector maps every candle/point through it on each bundle commit).
   */
  function toVirtual(realMs: number): number {
    if (segments.length === 0) return 0;
    const first = segments[0];
    if (realMs <= first.sessionOpenMs) return first.virtualStart;
    // realMs > first open ⇒ findByReal returns the last segment whose open
    // ≤ realMs (never -1 here).
    const idx = findByReal(realMs);
    const seg = segments[idx];
    if (realMs <= seg.sessionCloseMs) {
      return seg.virtualStart + (realMs - seg.sessionOpenMs);
    }
    // In the gap after seg (snap forward), or past the final close (clamp).
    const next = segments[idx + 1];
    return next ? next.virtualStart : virtualEnd(seg);
  }

  /**
   * Edge-case decisions:
   *  - Empty axis → 0.
   *  - virtualMs at/below the origin (segments[0].virtualStart) → clamped to
   *    first.sessionOpenMs.
   *  - virtualMs at a boundary (== next.virtualStart) → next.sessionOpenMs
   *    (the next segment owns its starting boundary).
   *  - virtualMs past the last virtual end → last.sessionCloseMs (clamped).
   */
  function toReal(virtualMs: number): number {
    if (segments.length === 0) return 0;
    if (virtualMs <= segments[0].virtualStart) return segments[0].sessionOpenMs;
    const idx = findByVirtual(virtualMs);
    if (idx < 0) return segments[0].sessionOpenMs;
    const seg = segments[idx];
    const offset = virtualMs - seg.virtualStart;
    const sessionLen = seg.sessionCloseMs - seg.sessionOpenMs;
    if (offset >= sessionLen) {
      const next = segments[idx + 1];
      if (next && virtualMs >= next.virtualStart) return next.sessionOpenMs;
      return seg.sessionCloseMs;
    }
    return seg.sessionOpenMs + offset;
  }

  function contains(realMs: number): boolean {
    // Delegates to the single domain source. Kept here for backward
    // compatibility with the many projectors that already call axis.contains.
    return isRegularSession(segments, realMs);
  }

  function isInGap(realMs: number): boolean {
    if (segments.length === 0) return false;
    if (realMs < segments[0].sessionOpenMs) return false;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (realMs >= seg.sessionOpenMs && realMs <= seg.sessionCloseMs) return false;
      if (realMs > seg.sessionCloseMs) {
        const next = segments[i + 1];
        if (!next) return true;
        if (realMs < next.sessionOpenMs) return true;
      }
    }
    return false;
  }

  function inClosingAuctionWindow(realMs: number): boolean {
    // Delegates to the single domain source. The legacy local logic is
    // gone; sessionTime.isClosingAuction handles half-day sessions (anchors
    // to sessionCloseMs - 10min) and pre-axis / gap rejection in one place.
    return isClosingAuction(segments, realMs);
  }

  function classifyAndProject(realMs: number): { contained: boolean; inAuction: boolean; virtual: number } {
    const { idx, phase } = locateSegment(segments, realMs);
    const contained = phase === 'regular' || phase === 'auction';
    if (!contained) return { contained: false, inAuction: false, virtual: 0 };
    const seg = segments[idx];
    return {
      contained: true,
      inAuction: phase === 'auction',
      virtual: seg.virtualStart + (realMs - seg.sessionOpenMs),
    };
  }

  return Object.freeze({
    segments,
    dayBoundaries,
    toVirtual,
    toReal,
    findByReal,
    findByVirtual,
    inClosingAuctionWindow,
    classifyAndProject,
    contains,
    isInGap,
  });
}
