/**
 * Pure geometry for the Session Tape — maps the KRX Regular Session
 * (09:00–15:30 KST) to a 0..1 progress track.
 *
 * Split from the component so the pre/in/post phase logic and the auction-tick
 * arithmetic are unit-testable without a DOM. `now`/`open`/`close` are real
 * Unix ms; the component supplies today's bounds via `regularSession*Ms`.
 */

/** Where the session clock sits relative to its Regular Session window. */
export type SessionPhase = 'pre' | 'in' | 'post';

export interface SessionProgress {
  /** Elapsed fraction of the session, clamped to [0, 1]. */
  fillPct: number;
  /** Playhead position, [0, 1]. Same as `fillPct` (the head rides the fill edge). */
  headPct: number;
  phase: SessionPhase;
}

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * Progress of `nowMs` through the `[openMs, closeMs]` window.
 * Degenerate window (close ≤ open) collapses to a pre-session zero.
 */
export function sessionProgress(nowMs: number, openMs: number, closeMs: number): SessionProgress {
  const span = closeMs - openMs;
  if (span <= 0) return { fillPct: 0, headPct: 0, phase: 'pre' };
  const phase: SessionPhase = nowMs < openMs ? 'pre' : nowMs > closeMs ? 'post' : 'in';
  const pct = clamp01((nowMs - openMs) / span);
  return { fillPct: pct, headPct: pct, phase };
}

/** KRX auction boundaries inside the Regular Session, as track fractions:
 * opening single-price auction lifts at 09:10 (open + 10m); the closing
 * auction begins at 15:20 (close − 10m). Returned as [openTick, closeTick]. */
export function auctionTickPcts(openMs: number, closeMs: number): [number, number] {
  const span = closeMs - openMs;
  if (span <= 0) return [0, 1];
  const tenMin = 10 * 60 * 1000;
  return [clamp01(tenMin / span), clamp01(1 - tenMin / span)];
}
