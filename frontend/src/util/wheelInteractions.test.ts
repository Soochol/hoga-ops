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
});
