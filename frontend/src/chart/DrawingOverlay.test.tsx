// frontend/src/chart/DrawingOverlay.test.tsx
//
// Focused unit tests for the empty-click deselect predicate that powers
// the window-level mousedown listener in DrawingOverlay. The full
// component requires IChartApi + VirtualAxis + paneSeries scaffolding,
// so we extract the predicate and test it in isolation. The companion
// integration coverage lives in the manual QA pass and in ADR-0030 /
// ADR-0032.

import { act, fireEvent, render } from '@testing-library/react';
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
        code="005930"
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

describe('DrawingOverlay text editor — pointer isolation', () => {
  beforeEach(() => {
    useDrawingsStore.getState().__resetForTests();
  });

  // Rich-enough chart/axis/paneSeries stubs for the text tool to resolve an
  // anchor and open the editor. Identity projections: px↔realMs/1000, py↔price.
  function mountWithCandlePane() {
    const fakePane = { paneIndex: () => 0, getHeight: () => 400 };
    const fakeSeries = {
      priceToCoordinate: (p: number) => p,
      coordinateToPrice: (y: number) => y,
      getPane: () => fakePane,
    };
    const chart = {
      timeScale: () => ({
        subscribeVisibleLogicalRangeChange: vi.fn(),
        unsubscribeVisibleLogicalRangeChange: vi.fn(),
        coordinateToTime: (x: number) => x,
        timeToCoordinate: (t: number) => t,
        coordinateToLogical: (x: number) => x,
        logicalToCoordinate: (l: number) => l,
      }),
      panes: () => [{ getHeight: () => 400, getSeries: () => [] }],
    };
    const axis = {
      segments: [{ date: '20260101', sessionOpenMs: 0, sessionCloseMs: 10_000_000, virtualStart: 0 }],
      contains: () => true,
      toVirtual: (v: number) => v,
      toReal: (v: number) => v,
    };
    return render(
      <DrawingOverlay
        chart={chart as never}
        code="005930"
        axis={axis as never}
        paneSeries={new Map([['candle', fakeSeries]]) as never}
      />,
    );
  }

  // Regression for the "입력창이 안 나와요" report: the editor opens at the
  // cursor, so a real user's next press lands ON the input (click-to-type,
  // double-click habit). That pointerdown used to bubble into the overlay's
  // tool dispatch → beginTextEdit saw an open edit → committed the empty value
  // → the box vanished the instant it was touched.
  it('clicking inside the open text input does NOT close it', () => {
    useDrawingsStore.getState().setActiveCode('005930');
    useDrawingsStore.getState().setActiveTool('text');
    const { container } = mountWithCandlePane();
    const overlay = container.querySelector('[data-drawing-overlay]')!;

    // Open the editor with a chart click.
    fireEvent.pointerDown(overlay, { clientX: 100, clientY: 50, button: 0 });
    fireEvent.pointerUp(overlay, { clientX: 100, clientY: 50, button: 0 });
    const input = container.querySelector('[data-drawing-text-input]');
    expect(input).not.toBeNull();

    // Press inside the input itself — must stay open (propagation stopped).
    fireEvent.pointerDown(input!, { clientX: 102, clientY: 52, button: 0 });
    fireEvent.pointerUp(input!, { clientX: 102, clientY: 52, button: 0 });
    expect(container.querySelector('[data-drawing-text-input]')).not.toBeNull();
  });

  // Regression for the focus-steal kill: a REAL click's native mousedown
  // (compat event, ~1ms after pointerdown) moves focus to the non-focusable
  // overlay, blurring the just-opened editor → onBlur commits empty → the box
  // unmounts within 3ms ("입력창이 안 나와요"). Canceling pointerdown for the
  // text tool suppresses the compat mousedown and its focus default (Pointer
  // Events spec), so the editor keeps focus. jsdom can't run native default
  // actions, so we pin the guard itself: defaultPrevented must be true for the
  // text tool and stay false for others (their gestures rely on defaults).
  it('text-tool pointerdown is defaultPrevented (focus-steal guard); select is not', () => {
    useDrawingsStore.getState().setActiveCode('005930');
    useDrawingsStore.getState().setActiveTool('text');
    const { container } = mountWithCandlePane();
    const overlay = container.querySelector('[data-drawing-overlay]')!;

    // fireEvent returns false when preventDefault() was called.
    const textNotPrevented = fireEvent.pointerDown(overlay, { clientX: 100, clientY: 50, button: 0 });
    expect(textNotPrevented).toBe(false);

    act(() => {
      useDrawingsStore.getState().setActiveTool('select');
    });
    const selectNotPrevented = fireEvent.pointerDown(overlay, { clientX: 300, clientY: 90, button: 0 });
    expect(selectNotPrevented).toBe(true);
  });
});

describe('DrawingOverlay undo/redo keyboard (ADR-0107)', () => {
  beforeEach(() => {
    useDrawingsStore.getState().__resetForTests();
  });

  function mountOverlay() {
    const chart = {
      timeScale: () => ({
        subscribeVisibleLogicalRangeChange: vi.fn(),
        unsubscribeVisibleLogicalRangeChange: vi.fn(),
      }),
      panes: () => [],
    };
    return render(
      <DrawingOverlay
        chart={chart as never}
        axis={{ segments: [] } as never}
        code="005930"
        paneSeries={new Map()}
      />,
    );
  }

  it('Ctrl+Z undoes and Ctrl+Shift+Z redoes the last mutation', () => {
    const s = () => useDrawingsStore.getState();
    s().setActiveCode('005930');
    s().add('005930', { id: 'h1', kind: 'hline', price: 100, color: '#fff', width: 1, lineStyle: 'solid', paneId: 'candle' });
    mountOverlay();
    expect(s().drawingsFor('005930')).toHaveLength(1);

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(s().drawingsFor('005930')).toHaveLength(0);

    fireEvent.keyDown(window, { key: 'Z', ctrlKey: true, shiftKey: true });
    expect(s().drawingsFor('005930')).toHaveLength(1);
  });

  it('Meta+Z (macOS) also undoes', () => {
    const s = () => useDrawingsStore.getState();
    s().setActiveCode('005930');
    s().add('005930', { id: 'h1', kind: 'hline', price: 100, color: '#fff', width: 1, lineStyle: 'solid', paneId: 'candle' });
    mountOverlay();
    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    expect(s().drawingsFor('005930')).toHaveLength(0);
  });
});
