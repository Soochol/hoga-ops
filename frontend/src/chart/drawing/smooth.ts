// frontend/src/chart/drawing/smooth.ts
//
// Centripetal Catmull–Rom smoothing for the pencil tool, expressed as cubic
// Bézier spans so the canvas draws it with one `bezierCurveTo` per span.
//
// Why a spline at all: RDP keeps the points that define a curve's SHAPE and
// throws away the rest, so what survives is a sparse set of vertices. Joining
// those with straight lines re-introduces the angularity the simplification was
// allowed to create — the stroke reads as a polygon at exactly the zoom levels
// where the sub-bar work made it smooth. The spline puts the curvature back
// between the kept vertices instead of paying to store it.
//
// Why Catmull–Rom rather than the more common midpoint-quadratic trick: a
// pencil stroke's whole meaning is "the line went where I dragged". Catmull–Rom
// INTERPOLATES — every original vertex is on the curve — whereas the midpoint
// scheme uses the vertices as control points and passes between them. That also
// keeps the rendered curve near the vertex polyline, which is what hit-testing
// walks (see `hitTest.ts`).
//
// Why CENTRIPETAL (α = 0.5) rather than uniform: with unevenly spaced points —
// exactly what RDP produces, dense through curves and sparse along straights —
// the uniform parameterisation overshoots and can loop back on itself near a
// sharp turn. Centripetal is the variant proven free of cusps and
// self-intersections for any input.

export type Px = { x: number; y: number };

/** One cubic Bézier span: two control points plus the vertex it lands on.
 *  The span STARTS at the previous vertex, which the caller has already
 *  reached via `moveTo` or a preceding span. */
export type BezierSpan = { c1: Px; c2: Px; to: Px };

/** Centripetal exponent: knot spacing is `|Δp|^0.5`. */
const ALPHA = 0.5;

/** Knot spacings below this (in px^ALPHA) are treated as coincident points.
 *  Guards the division in the tangent formula; 1e-9 is far under any spacing a
 *  real stroke produces (two samples one hundredth of a pixel apart still give
 *  0.1). */
const EPS = 1e-9;

function knotDelta(a: Px, b: Px): number {
  return Math.hypot(b.x - a.x, b.y - a.y) ** ALPHA;
}

/**
 * Tangent of the centripetal Catmull–Rom curve at `p1`, for the span p1→p2
 * flanked by `p0` and… — this is the exact derivative of the Barry–Goldman
 * pyramidal form at the knot, NOT an approximation:
 *
 *   C'(t1) = [ (t2−t1)/(t1−t0)·(p1−p0) + (t1−t0)/(t2−t1)·(p2−p1) ] / (t2−t0)
 *
 * Because a Catmull–Rom span is a cubic polynomial in t, matching both
 * endpoints and both endpoint derivatives (Hermite) determines it uniquely —
 * so the Bézier built from these tangents IS the spline, not a curve near it.
 * `smooth.test.ts` pins that against an independent Barry–Goldman evaluator.
 *
 * A coincident flank (d01 ≈ 0) collapses the weighted blend to the plain
 * secant, which is the limit the formula approaches anyway.
 */
function tangentAt(p0: Px, p1: Px, p2: Px, d01: number, d12: number): Px {
  if (d12 < EPS) return { x: 0, y: 0 };
  if (d01 < EPS) return { x: (p2.x - p1.x) / d12, y: (p2.y - p1.y) / d12 };
  const w = 1 / (d01 + d12);
  return {
    x: ((d12 / d01) * (p1.x - p0.x) + (d01 / d12) * (p2.x - p1.x)) * w,
    y: ((d12 / d01) * (p1.y - p0.y) + (d01 / d12) * (p2.y - p1.y)) * w,
  };
}

/**
 * Bézier spans covering `pts[0]…pts[n-1]`, one per consecutive pair. Returns
 * `[]` for fewer than two points; a two-point input yields the single span
 * whose controls sit on the chord (i.e. a straight line), so callers need no
 * special case beyond `moveTo(pts[0])`.
 *
 * The end conditions REFLECT — the phantom point before the first is
 * `2·p0 − p1`. Note that duplicating instead (`p0` twice) computes the SAME
 * end tangent: duplication zeroes the first knot spacing and takes the
 * coincident-flank branch, which returns the chord direction, and reflection
 * makes `p1 − p0 = p2 − p1` so the general formula converges on that same
 * chord direction. The choice is therefore about which branch a normal stroke
 * runs through, not about the curve: reflecting keeps every ordinary stroke on
 * the general path and leaves the degenerate guard as a signal of genuinely
 * coincident input. (A red-check confirmed the two are indistinguishable by
 * output — do not "fix" one into the other expecting a visual difference.)
 */
export function catmullRomSpans(pts: readonly Px[]): BezierSpan[] {
  const n = pts.length;
  if (n < 2) return [];
  const spans: BezierSpan[] = [];
  for (let i = 0; i < n - 1; i++) {
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p0 = i > 0 ? pts[i - 1] : { x: 2 * p1.x - p2.x, y: 2 * p1.y - p2.y };
    const p3 = i + 2 < n ? pts[i + 2] : { x: 2 * p2.x - p1.x, y: 2 * p2.y - p1.y };
    const d01 = knotDelta(p0, p1);
    const d12 = knotDelta(p1, p2);
    const d23 = knotDelta(p2, p3);
    // Coincident pair: no span to draw a curve across. Emit the (degenerate)
    // straight span so the caller's path stays continuous and the vertex count
    // still matches the input.
    if (d12 < EPS) {
      spans.push({ c1: p1, c2: p2, to: p2 });
      continue;
    }
    const m1 = tangentAt(p0, p1, p2, d01, d12);
    // Mirror image of the same formula, read from p2 looking backwards.
    const m2 = tangentAt(p3, p2, p1, d23, d12);
    // Bézier controls sit one third of the span's parameter length along each
    // endpoint tangent. `d12` is that parameter length (t2 − t1).
    const k = d12 / 3;
    spans.push({
      c1: { x: p1.x + m1.x * k, y: p1.y + m1.y * k },
      // m2 points backwards (p2 → p1), so it is ADDED, not subtracted.
      c2: { x: p2.x + m2.x * k, y: p2.y + m2.y * k },
      to: p2,
    });
  }
  return spans;
}
