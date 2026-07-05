// frontend/src/chart/DrawingOverlay.test.tsx
//
// Focused unit tests for the empty-click deselect predicate that powers
// the window-level mousedown listener in DrawingOverlay. The full
// component requires IChartApi + VirtualAxis + paneSeries scaffolding,
// so we extract the predicate and test it in isolation. The companion
// integration coverage lives in the manual QA pass and in ADR-0030 /
// ADR-0032.

import { fireEvent, render } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import DrawingOverlay, { __test__ } from './DrawingOverlay';
import { useDrawingsStore } from '../state/drawings';

const { shouldDeselectOnClick } = __test__;

describe('shouldDeselectOnClick', () => {
  const rect = { width: 800, height: 400 };

  it('returns true when the click is inside the overlay and misses every drawing', () => {
    expect(shouldDeselectOnClick({ x: 100, y: 50 }, rect, false, false)).toBe(true);
  });

  it('returns false when the click is inside the overlay but hits a drawing', () => {
    expect(shouldDeselectOnClick({ x: 100, y: 50 }, rect, true, false)).toBe(false);
  });

  it('returns false when the click is outside the overlay bounds', () => {
    // Outside on the right edge.
    expect(shouldDeselectOnClick({ x: 900, y: 50 }, rect, false, false)).toBe(false);
    // Outside on the bottom edge.
    expect(shouldDeselectOnClick({ x: 100, y: 500 }, rect, false, false)).toBe(false);
    // Negative — pointer is left/above the overlay.
    expect(shouldDeselectOnClick({ x: -1, y: 50 }, rect, false, false)).toBe(false);
    expect(shouldDeselectOnClick({ x: 100, y: -1 }, rect, false, false)).toBe(false);
  });

  // ADR-0032 — Drawing Property Panel guard. The panel renders over the
  // chart area; its mousedown events would otherwise trigger empty-click
  // deselect, clearing selectedId and unmounting the panel before the
  // user's edit (color / thickness / lineStyle) registers. The delete
  // button worked anyway because it captured `id` in a closure before
  // selectedId went null — masking the bug. This test pins the guard.
  it('returns false when the click originates on the Drawing Property Panel, even if otherwise eligible', () => {
    // Inside the overlay, misses every drawing — would normally deselect.
    // The panel guard wins.
    expect(shouldDeselectOnClick({ x: 100, y: 50 }, rect, false, true)).toBe(false);
  });

  it('the panel guard does not override a click that already hits a drawing', () => {
    // No state change required either way — the click hits a drawing, so
    // empty-click semantics never apply. Asserting both panel-true and
    // panel-false return the same answer keeps the rule orthogonal.
    expect(shouldDeselectOnClick({ x: 100, y: 50 }, rect, true, true)).toBe(false);
    expect(shouldDeselectOnClick({ x: 100, y: 50 }, rect, true, false)).toBe(false);
  });
});

describe('DrawingOverlay context menu', () => {
  beforeEach(() => {
    useDrawingsStore.getState().__resetForTests();
  });

  it('switches back to select mode on right-click and suppresses the browser menu', () => {
    useDrawingsStore.getState().setActiveTool('trendline');
    const chart = {
      timeScale: () => ({
        subscribeVisibleLogicalRangeChange: vi.fn(),
        unsubscribeVisibleLogicalRangeChange: vi.fn(),
      }),
      panes: () => [],
    };
    const { container } = render(
      <DrawingOverlay
        chart={chart as never}
        axis={{ segments: [] } as never}
        paneSeries={new Map()}
      />,
    );
    const overlay = container.querySelector('[data-drawing-overlay]');
    expect(overlay).not.toBeNull();

    const prevented = !fireEvent.contextMenu(overlay!);

    expect(prevented).toBe(true);
    expect(useDrawingsStore.getState().activeTool).toBe('select');
  });
});
