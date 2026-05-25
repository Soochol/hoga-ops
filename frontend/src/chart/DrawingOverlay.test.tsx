// frontend/src/chart/DrawingOverlay.test.tsx
//
// Focused unit tests for the empty-click deselect predicate that powers
// the window-level mousedown listener in DrawingOverlay. The full
// component requires IChartApi + VirtualAxis + paneSeries scaffolding,
// so we extract the predicate and test it in isolation. The companion
// integration coverage lives in the manual QA pass (plan Task 3 Step 5.5)
// and ADR-0030.

import { describe, it, expect } from 'vitest';
import { __test__ } from './DrawingOverlay';

const { shouldDeselectOnClick } = __test__;

describe('shouldDeselectOnClick', () => {
  const rect = { width: 800, height: 400 };

  it('returns true when the click is inside the overlay and misses every drawing', () => {
    expect(shouldDeselectOnClick({ x: 100, y: 50 }, rect, false)).toBe(true);
  });

  it('returns false when the click is inside the overlay but hits a drawing', () => {
    expect(shouldDeselectOnClick({ x: 100, y: 50 }, rect, true)).toBe(false);
  });

  it('returns false when the click is outside the overlay bounds', () => {
    // Outside on the right edge.
    expect(shouldDeselectOnClick({ x: 900, y: 50 }, rect, false)).toBe(false);
    // Outside on the bottom edge.
    expect(shouldDeselectOnClick({ x: 100, y: 500 }, rect, false)).toBe(false);
    // Negative — pointer is left/above the overlay.
    expect(shouldDeselectOnClick({ x: -1, y: 50 }, rect, false)).toBe(false);
    expect(shouldDeselectOnClick({ x: 100, y: -1 }, rect, false)).toBe(false);
  });
});
