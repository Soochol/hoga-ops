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
  if (segments.length === 0) return 'pre-axis';

  const first = segments[0];
  if (realMs < first.sessionOpenMs - PRE_OPEN_WINDOW_LENGTH_MS) return 'pre-axis';

  // preOpenStart(= open − 30min) ≤ realMs 인 마지막 세그먼트를 이진 탐색 —
  // findByReal(virtualAxis.ts)과 같은 lower-bound 패턴, 키만 preOpenStart.
  // 전제: 세그먼트 정렬·비중첩(buildSegments 불변식). projector 핫패스가
  // 캔들마다 contains/inClosingAuctionWindow로 2회 부르므로 선형 워크는
  // 250일 스크롤에서 projection당 수천만 비교가 된다(스펙 2026-06-08).
  let lo = 0;
  let hi = segments.length - 1;
  let idx = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (segments[mid].sessionOpenMs - PRE_OPEN_WINDOW_LENGTH_MS <= realMs) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const seg = segments[idx];
  if (realMs <= seg.sessionCloseMs) return classifyWithinSegment(seg, realMs);
  // seg 마감 뒤 ~ 다음 세그먼트 pre-open 시작 전 구간. idx가 마지막이면 post-axis.
  return idx === segments.length - 1 ? 'post-axis' : 'gap';
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
