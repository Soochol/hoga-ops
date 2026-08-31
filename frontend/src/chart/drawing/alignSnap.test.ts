// frontend/src/chart/drawing/alignSnap.test.ts
import { describe, expect, it } from 'vitest';
import {
  ALIGN_SNAP_PX,
  alignSnapBox,
  anchorsOf,
  pointAnchors,
  type SnapBox,
} from './alignSnap';

// Identity converters: 1 domain unit == 1 pixel, so every threshold assertion
// below reads directly as the distance under test.
const id = (v: number) => v;
const identity = { xToPx: id, yToPx: id };

/** A box from its four edges, in the kernel's (x, y) domain. */
function box(name: string, x1: number, x2: number, y1: number, y2: number): SnapBox {
  return { id: name, x: anchorsOf(x1, x2), y: anchorsOf(y1, y2) };
}

function moving(x1: number, x2: number, y1: number, y2: number) {
  return { x: anchorsOf(x1, x2), y: anchorsOf(y1, y2) };
}

describe('anchorsOf', () => {
  it('normalizes crossed corners and derives the center', () => {
    expect(anchorsOf(30, 10)).toEqual({ min: 10, max: 30, center: 20 });
  });
  it('pointAnchors collapses all three onto one value', () => {
    expect(pointAnchors(7)).toEqual({ min: 7, max: 7, center: 7 });
  });
});

describe('alignSnapBox — no candidates', () => {
  it('returns a zero correction when the target list is empty', () => {
    expect(alignSnapBox(moving(0, 10, 0, 10), [], identity)).toEqual({
      dx: 0,
      dy: 0,
      guides: [],
    });
  });
  it('returns a zero correction when every candidate is beyond threshold', () => {
    const far = [box('t', 500, 510, 500, 510)];
    const r = alignSnapBox(moving(0, 10, 0, 10), far, identity);
    expect(r.dx).toBe(0);
    expect(r.dy).toBe(0);
    expect(r.guides).toEqual([]);
  });
});

describe('alignSnapBox — edge alignment (my left = your left)', () => {
  it('pulls the moving box so the two left edges coincide', () => {
    // target left = 100; moving left = 103 → 3px away, inside the threshold.
    const targets = [box('t', 100, 140, 0, 40)];
    const r = alignSnapBox(moving(103, 143, 200, 240), targets, identity);
    expect(r.dx).toBe(-3);
  });
  it('copies the target value verbatim rather than a rounded pixel', () => {
    // A fractional target edge must survive: the commit is a domain copy.
    const targets = [box('t', 100.25, 140, 0, 40)];
    const r = alignSnapBox(moving(103, 143, 200, 240), targets, identity);
    expect(103 + r.dx).toBe(100.25);
  });
});

describe('alignSnapBox — abutment (my left = your right)', () => {
  it('snaps the moving box flush against the target it approaches', () => {
    // target right = 140; moving left = 145 → 5px, inside threshold.
    const targets = [box('t', 100, 140, 0, 40)];
    const r = alignSnapBox(moving(145, 175, 200, 240), targets, identity);
    expect(145 + r.dx).toBe(140);
  });
});

describe('alignSnapBox — center alignment', () => {
  it('aligns centers when that is the nearest pairing', () => {
    // A NARROWER moving box, so no edge pair can win: target is 100..140
    // (center 120), moving is 112..132 (center 122). Edge distances are 12 / 8
    // / 8 — all at or beyond the threshold — leaving centers (2 apart) alone
    // inside it. Equal widths would make min↔min and center↔center tie, and
    // the tie-break would silently decide the test.
    const targets = [box('t', 100, 140, 0, 40)];
    const r = alignSnapBox(moving(112, 132, 900, 940), targets, identity);
    expect(122 + r.dx).toBe(120);
  });
});

describe('alignSnapBox — axes are independent', () => {
  it('snaps X while leaving Y untouched', () => {
    const targets = [box('t', 100, 140, 0, 40)];
    // X within threshold (2), Y nowhere near (starts at 300).
    const r = alignSnapBox(moving(102, 142, 300, 340), targets, identity);
    expect(r.dx).toBe(-2);
    expect(r.dy).toBe(0);
  });
  it('snaps Y while leaving X untouched', () => {
    const targets = [box('t', 100, 140, 0, 40)];
    const r = alignSnapBox(moving(300, 340, 3, 43), targets, identity);
    expect(r.dx).toBe(0);
    expect(r.dy).toBe(-3);
  });
  it('snaps both axes at once, to different targets if that is nearest', () => {
    const targets = [box('a', 100, 140, 0, 40), box('b', 700, 740, 500, 540)];
    const r = alignSnapBox(moving(102, 142, 503, 543), targets, identity);
    expect(r.dx).toBe(-2);
    expect(r.dy).toBe(-3);
    expect(r.guides).toHaveLength(2);
  });
});

describe('alignSnapBox — threshold boundary', () => {
  it('snaps strictly inside the threshold and not at it', () => {
    const targets = [box('t', 100, 140, 0, 40)];
    // The moving box runs far to the right (…→500) so its max/center anchors
    // are nowhere near the target: ONLY the left-edge pair is in play, and the
    // assertion measures exactly the distance it is named for.
    const inside = alignSnapBox(
      moving(100 + ALIGN_SNAP_PX - 1, 500, 900, 940),
      targets,
      identity,
    );
    expect(inside.dx).toBe(-(ALIGN_SNAP_PX - 1));
    const at = alignSnapBox(moving(100 + ALIGN_SNAP_PX, 500, 900, 940), targets, identity);
    expect(at.dx).toBe(0);
  });
  it('measures in PIXELS, not domain units', () => {
    // 10x zoom: a 3-unit domain gap is 30px on screen — out of reach.
    const targets = [box('t', 100, 140, 0, 40)];
    const zoomed = { xToPx: (v: number) => v * 10, yToPx: (v: number) => v * 10 };
    expect(alignSnapBox(moving(103, 143, 900, 940), targets, zoomed).dx).toBe(0);
    // …and the same domain gap DOES snap at 1x.
    expect(alignSnapBox(moving(103, 143, 900, 940), targets, identity).dx).toBe(-3);
  });
});

describe('alignSnapBox — nearest wins', () => {
  it('picks the closer of two in-threshold candidates', () => {
    const targets = [box('far', 100, 140, 0, 40), box('near', 105, 145, 0, 40)];
    // moving left = 106: 1 from 'near'.min, 6 from 'far'.min.
    const r = alignSnapBox(moving(106, 146, 900, 940), targets, identity);
    expect(106 + r.dx).toBe(105);
    expect(r.guides[0]?.axis).toBe('x');
  });
});

describe('alignSnapBox — unresolvable coordinates', () => {
  it('skips a candidate whose pixel position is null instead of treating it as 0', () => {
    const targets = [box('t', 100, 140, 0, 40)];
    const blindX = { xToPx: () => null, yToPx: id };
    const r = alignSnapBox(moving(102, 142, 3, 43), targets, blindX);
    expect(r.dx).toBe(0);
    expect(r.dy).toBe(-3);
  });
});

describe('alignSnapBox — accept vetoes', () => {
  it('drops a vetoed X snap but keeps the Y snap', () => {
    const targets = [box('t', 100, 140, 0, 40)];
    const r = alignSnapBox(moving(102, 142, 3, 43), targets, {
      ...identity,
      acceptX: () => false,
    });
    expect(r.dx).toBe(0);
    expect(r.dy).toBe(-3);
    expect(r.guides.map((g) => g.axis)).toEqual(['y']);
  });
  it('a vetoed axis does not shift the surviving guide extent', () => {
    const targets = [box('t', 100, 140, 0, 40)];
    const r = alignSnapBox(moving(102, 142, 3, 43), targets, {
      ...identity,
      acceptY: () => false,
    });
    // X snapped by -2, Y did not move: the vertical guide spans the moving
    // box's UNSHIFTED y range (3..43) unioned with the target's (0..40).
    expect(r.guides).toEqual([{ axis: 'x', at: 100, from: 0, to: 43 }]);
  });
});

describe('alignSnapBox — guides', () => {
  it('spans both boxes on the cross axis', () => {
    const targets = [box('t', 100, 140, 0, 40)];
    const r = alignSnapBox(moving(102, 142, 60, 100), targets, identity);
    // Vertical guide at the aligned x, running from the target's top (0) to
    // the moving box's bottom (100) so it visibly connects the two.
    expect(r.guides).toEqual([{ axis: 'x', at: 100, from: 0, to: 100 }]);
  });
  it('accounts for the other axis snap in the cross-axis extent', () => {
    // Y also snaps (-3), so the vertical guide must span the POST-snap y range.
    const targets = [box('t', 100, 140, 0, 40)];
    const r = alignSnapBox(moving(102, 142, 43, 83), targets, identity);
    const vertical = r.guides.find((g) => g.axis === 'x');
    expect(vertical).toEqual({ axis: 'x', at: 100, from: 0, to: 80 });
  });
});

describe('alignSnapBox — degenerate moving box (creation / resize)', () => {
  it('snaps a bare point to a neighbouring edge on both axes', () => {
    const targets = [box('t', 100, 140, 0, 40)];
    const r = alignSnapBox(
      { x: pointAnchors(142), y: pointAnchors(38) },
      targets,
      identity,
    );
    expect(142 + r.dx).toBe(140);
    expect(38 + r.dy).toBe(40);
  });
});
