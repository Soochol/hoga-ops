import { describe, expect, it, vi } from 'vitest';
import { computeWheelOutcome, type WheelInput } from './wheelInteractions';

// Reusable base — tests override the fields they care about.
function baseInput(over: Partial<WheelInput> = {}): WheelInput {
  return {
    range: { from: 0, to: 100 },
    deltaY: 100,
    shiftKey: false,
    ctrlOrMetaKey: false,
    mouseX: 0,
    coordinateToLogical: () => 50,
    maxTo: Number.POSITIVE_INFINITY,
    ...over,
  };
}

describe('computeWheelOutcome', () => {
  describe('plain wheel — right-edge-anchored zoom', () => {
    it('zooms out keeping `to` fixed when deltaY > 0', () => {
      const out = computeWheelOutcome(baseInput({ deltaY: 100 }));
      expect(out).not.toBeNull();
      expect(out!.to).toBe(100);
      expect(out!.from).toBeLessThan(0); // span grew, `from` moved left
    });

    it('zooms in keeping `to` fixed when deltaY < 0', () => {
      const out = computeWheelOutcome(baseInput({ deltaY: -100 }));
      expect(out).not.toBeNull();
      expect(out!.to).toBe(100);
      expect(out!.from).toBeGreaterThan(0); // span shrank, `from` moved right
    });

    it('does not call coordinateToLogical when no Ctrl/Cmd', () => {
      const spy = vi.fn(() => 50);
      computeWheelOutcome(baseInput({ deltaY: 100, coordinateToLogical: spy }));
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('Ctrl/Cmd wheel — mouse-anchored zoom', () => {
    it('expands both edges outward from the anchor on zoom out', () => {
      const out = computeWheelOutcome(
        baseInput({
          deltaY: 100,
          ctrlOrMetaKey: true,
          coordinateToLogical: () => 50, // anchor in the middle
        }),
      );
      expect(out).not.toBeNull();
      expect(out!.from).toBeLessThan(0);
      expect(out!.to).toBeGreaterThan(100);
    });

    it('contracts both edges toward the anchor on zoom in', () => {
      const out = computeWheelOutcome(
        baseInput({
          deltaY: -100,
          ctrlOrMetaKey: true,
          coordinateToLogical: () => 50,
        }),
      );
      expect(out).not.toBeNull();
      expect(out!.from).toBeGreaterThan(0);
      expect(out!.to).toBeLessThan(100);
    });

    it('falls back to `to` as anchor when coordinateToLogical returns null', () => {
      const out = computeWheelOutcome(
        baseInput({
          deltaY: 100,
          ctrlOrMetaKey: true,
          coordinateToLogical: () => null,
        }),
      );
      // With anchor = to (100), span 100 → factor ~1.105
      // from' = 100 - (100 - 0) * 1.105 ≈ -10.5; to' = 100 + (100 - 100) * 1.105 = 100
      expect(out).not.toBeNull();
      expect(out!.to).toBe(100);
      expect(out!.from).toBeLessThan(0);
    });
  });

  describe('Shift wheel — pan', () => {
    it('pans right (toward future) on deltaY > 0, span unchanged', () => {
      const out = computeWheelOutcome(baseInput({ deltaY: 100, shiftKey: true }));
      expect(out).toEqual({ from: 10, to: 110 });
    });

    it('pans left (toward past) on deltaY < 0', () => {
      const out = computeWheelOutcome(baseInput({ deltaY: -100, shiftKey: true }));
      expect(out).toEqual({ from: -10, to: 90 });
    });

    it('returns null when deltaY is zero (no direction)', () => {
      expect(computeWheelOutcome(baseInput({ deltaY: 0, shiftKey: true }))).toBeNull();
    });
  });

  describe('modifier precedence', () => {
    it('Shift wins over Ctrl/Cmd when both held', () => {
      const out = computeWheelOutcome(
        baseInput({ deltaY: 100, shiftKey: true, ctrlOrMetaKey: true }),
      );
      // Pan result, not zoom
      expect(out).toEqual({ from: 10, to: 110 });
    });
  });

  describe('degenerate inputs', () => {
    it('returns null for zero-width range', () => {
      expect(
        computeWheelOutcome(baseInput({ range: { from: 5, to: 5 } })),
      ).toBeNull();
    });

    it('returns null for negative-width range', () => {
      expect(
        computeWheelOutcome(baseInput({ range: { from: 10, to: 5 } })),
      ).toBeNull();
    });
  });

  describe('right wall — Ctrl/Cmd zoom-out clamp', () => {
    it('clamps `to` to maxTo when ctrl zoom-out would push past the wall', () => {
      // range={50,99}, anchor=80, deltaY=100, maxTo=100
      // span=49, factor=exp(0.1)≈1.105
      // newFrom = 80 - (80-50)*1.105 ≈ 46.85
      // newTo   = 80 + (99-80)*1.105 ≈ 100.99  → clamp to 100
      const out = computeWheelOutcome(
        baseInput({
          range: { from: 50, to: 99 },
          deltaY: 100,
          ctrlOrMetaKey: true,
          coordinateToLogical: () => 80,
          maxTo: 100,
        }),
      );
      expect(out).not.toBeNull();
      expect(out!.to).toBe(100);
      expect(out!.from).toBeCloseTo(46.85, 1);
    });

    it('does not clamp ctrl zoom-out that stays under the wall', () => {
      // range={50,90}, anchor=70, deltaY=100, maxTo=100
      // newTo ≈ 70 + 20*1.105 = 92.1 — below wall
      const out = computeWheelOutcome(
        baseInput({
          range: { from: 50, to: 90 },
          deltaY: 100,
          ctrlOrMetaKey: true,
          coordinateToLogical: () => 70,
          maxTo: 100,
        }),
      );
      expect(out).not.toBeNull();
      expect(out!.to).toBeCloseTo(92.1, 1);
      expect(out!.from).toBeCloseTo(47.9, 1);
    });

    it('does not clamp ctrl zoom-in even when current `to` is past the wall', () => {
      // range={0,115}, anchor=50, deltaY=-100, maxTo=100
      // factor < 1 — newTo < to, direction gate prevents clamp
      const out = computeWheelOutcome(
        baseInput({
          range: { from: 0, to: 115 },
          deltaY: -100,
          ctrlOrMetaKey: true,
          coordinateToLogical: () => 50,
          maxTo: 100,
        }),
      );
      expect(out).not.toBeNull();
      expect(out!.to).toBeLessThan(115);
      // No clamp applied — to should be the formula value, not 100.
      expect(out!.to).not.toBe(100);
    });
  });

  describe('right wall — Shift pan-right clamp', () => {
    it('does not clamp shift pan-right that stays under the wall', () => {
      // range={50,90}, deltaY=100, maxTo=100; span=40, step=4 → newTo=94
      const out = computeWheelOutcome(
        baseInput({
          range: { from: 50, to: 90 },
          deltaY: 100,
          shiftKey: true,
          maxTo: 100,
        }),
      );
      expect(out).toEqual({ from: 54, to: 94 });
    });

    it('clamps shift pan-right at the wall, preserving span', () => {
      // range={50,99}, deltaY=100, maxTo=100; span=49, step=4.9 → newTo=103.9
      // Clamp to=100, from=100-49=51
      const out = computeWheelOutcome(
        baseInput({
          range: { from: 50, to: 99 },
          deltaY: 100,
          shiftKey: true,
          maxTo: 100,
        }),
      );
      expect(out).toEqual({ from: 51, to: 100 });
    });

    it('does not clamp shift pan-left even when `to` is past the wall', () => {
      // range={20,115}, deltaY=-100, maxTo=100; step=-9.5
      const out = computeWheelOutcome(
        baseInput({
          range: { from: 20, to: 115 },
          deltaY: -100,
          shiftKey: true,
          maxTo: 100,
        }),
      );
      expect(out).toEqual({ from: 10.5, to: 105.5 });
    });

    it('clamps shift pan-right with large span preserving span at wall', () => {
      // range={5,95}, deltaY=100, maxTo=100; span=90, step=9 → newTo=104
      // Clamp to=100, from=100-90=10
      const out = computeWheelOutcome(
        baseInput({
          range: { from: 5, to: 95 },
          deltaY: 100,
          shiftKey: true,
          maxTo: 100,
        }),
      );
      expect(out).toEqual({ from: 10, to: 100 });
    });
  });

  describe('right wall — plain wheel and Infinity maxTo', () => {
    it('plain wheel ignores maxTo entirely', () => {
      // Plain wheel keeps `to` fixed regardless of maxTo.
      const out = computeWheelOutcome(
        baseInput({
          range: { from: 0, to: 100 },
          deltaY: 100,
          maxTo: 50, // wall well below current to
        }),
      );
      expect(out).not.toBeNull();
      expect(out!.to).toBe(100); // unchanged
      expect(out!.from).toBeLessThan(0);
    });

    it('maxTo=Infinity preserves pre-wall behavior on ctrl', () => {
      const out = computeWheelOutcome(
        baseInput({
          range: { from: 0, to: 100 },
          deltaY: 100,
          ctrlOrMetaKey: true,
          coordinateToLogical: () => 50,
          maxTo: Number.POSITIVE_INFINITY,
        }),
      );
      expect(out).not.toBeNull();
      expect(out!.to).toBeGreaterThan(100); // no clamp
    });

    it('maxTo=Infinity preserves pre-wall behavior on shift', () => {
      const out = computeWheelOutcome(
        baseInput({
          range: { from: 0, to: 100 },
          deltaY: 100,
          shiftKey: true,
          maxTo: Number.POSITIVE_INFINITY,
        }),
      );
      expect(out).toEqual({ from: 10, to: 110 });
    });
  });
});
