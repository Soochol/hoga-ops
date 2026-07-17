// frontend/src/chart/drawing/tools.test.ts
//
// Direct unit tests against tool specs — proves the new seam: each tool
// is testable in isolation by constructing a ToolCtx stub. No React,
// no canvas, no store. This is the testability benefit the
// improve-codebase-architecture deepening claimed.

import { describe, expect, it, vi } from 'vitest';
import {
  TOOLS,
  DRAWABLE_TOOLS_ORDER,
  hlineTool,
  vlineTool,
  eraserTool,
  pencilTool,
  rectTool,
  measureTool,
  textTool,
  selectTool,
  trendlineTool,
  matchShortcut,
  type ToolCtx,
} from './tools';
import type { Drawing, Point } from './types';
import { createVirtualAxis } from '../../util/virtualAxis';
import { dragTimeDomain } from './chartCoordinates';

function makeCtx(overrides: Partial<ToolCtx> = {}): ToolCtx {
  const defaultPoint: Point = { realMs: 1_700_000_000_000, price: 70_000 };
  const base: ToolCtx = {
    px: 100,
    py: 200,
    pointerId: 1,
    capturePointer: vi.fn(),
    revertToSelectMode: vi.fn(),
    releasePointer: vi.fn(),
    pixelToData: vi.fn(() => defaultPoint),
    realMsToCanvasX: vi.fn(() => 100),
    canvasXToRealMs: vi.fn(() => defaultPoint.realMs),
    priceToCanvasY: vi.fn(() => 200),
    canvasYToPrice: vi.fn(() => defaultPoint.price),
    hitTestAt: vi.fn(() => null),
    paneIdAtY: vi.fn(() => 'candle' as const),
    clampYToPane: vi.fn((_id, py) => py),
    priceBoundsForPane: vi.fn(() => ({ top: 100_000, bottom: 0 })),
    // Identity time domain: virtual == real. Gap-aware behavior is covered by
    // the dragTimeDomain tests (chartCoordinates.test.ts) and the dedicated
    // gap-crossing drag test below.
    dragTime: { toVirtual: (ms: number) => ms, toReal: (v: number) => v, originV: -Infinity },
    drawings: [],
    selectedId: null,
    defaults: { color: '#14B8A6', width: 2, lineStyle: 'solid' as const, fontSize: 13, magnet: false, hiddenAll: false },
    shiftKey: false,
    trendlineDraft: { current: null },
    pencilDraft: { current: null },
    rectDraft: { current: null },
    measureDraft: { current: null },
    dragRef: { current: null },
    beginTextEdit: vi.fn(),
    requestRedraw: vi.fn(),
    add: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    setSelected: vi.fn(),
  };
  return { ...base, ...overrides };
}

describe('TOOLS registry shape', () => {
  it('covers every DrawingTool union member', () => {
    // If the union grows, this fails to compile — the cast forces alignment.
    const keys: string[] = Object.keys(TOOLS).sort();
    expect(keys).toEqual([
      'eraser', 'hline', 'measure', 'pencil', 'rect', 'select', 'text', 'trendline', 'vline',
    ]);
  });

  it('DRAWABLE_TOOLS_ORDER lists only non-select tools', () => {
    expect(DRAWABLE_TOOLS_ORDER).not.toContain('select');
    expect(DRAWABLE_TOOLS_ORDER).toEqual([
      'hline', 'vline', 'trendline', 'rect', 'measure', 'text', 'pencil', 'eraser',
    ]);
  });

  it('every spec carries a label + glyph (DrawingMenu reads both)', () => {
    for (const spec of Object.values(TOOLS)) {
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.glyph.length).toBeGreaterThan(0);
    }
  });
});

describe('hlineTool.onPointerDown', () => {
  it('adds an Hline at the cursor price', () => {
    const ctx = makeCtx();
    hlineTool.onPointerDown!(ctx);
    expect(ctx.add).toHaveBeenCalledOnce();
    const added = (ctx.add as ReturnType<typeof vi.fn>).mock.calls[0][0] as Drawing;
    expect(added.kind).toBe('hline');
    if (added.kind === 'hline') {
      expect(added.price).toBe(70_000);
      expect(added.color).toBe('#14B8A6');
    }
  });

  // Empty right band past the last candle: coordinateToTime → null so
  // pixelToData → null, but the price scale spans the full chart width, so
  // canvasYToPrice still resolves. hline is price-only (no realMs), so creation
  // must succeed there off the Y axis alone. Regression: the old code routed
  // creation through pixelToData and aborted in the band — the user could add an
  // hline over candles but not in the empty area. Mirrors the shipped body-drag
  // fix (selectTool block below). See chartCoordinates.ts canvasYToPrice.
  it('adds an hline in the empty band where pixelToData is null but canvasYToPrice resolves', () => {
    const ctx = makeCtx({
      pixelToData: vi.fn(() => null),
      canvasYToPrice: vi.fn(() => 70_000),
    });
    hlineTool.onPointerDown!(ctx);
    expect(ctx.add).toHaveBeenCalledOnce();
    const added = (ctx.add as ReturnType<typeof vi.fn>).mock.calls[0][0] as Drawing;
    expect(added.kind).toBe('hline');
    if (added.kind === 'hline') expect(added.price).toBe(70_000);
  });

  it('does nothing when the price scale is unavailable (both pixelToData and canvasYToPrice null)', () => {
    const ctx = makeCtx({ pixelToData: vi.fn(() => null), canvasYToPrice: vi.fn(() => null) });
    hlineTool.onPointerDown!(ctx);
    expect(ctx.add).not.toHaveBeenCalled();
  });

  it('uses the snapped pixelToData price (magnet) over canvasYToPrice when available', () => {
    // pixelToData is the snapped path; its price must win over the raw
    // canvasYToPrice so magnet snapping reaches the committed hline.
    const ctx = makeCtx({
      pixelToData: vi.fn(() => ({ realMs: 1_700_000_000_000, price: 71_500 })),
      canvasYToPrice: vi.fn(() => 71_342.7),
    });
    hlineTool.onPointerDown!(ctx);
    const added = (ctx.add as ReturnType<typeof vi.fn>).mock.calls[0][0] as Drawing;
    if (added.kind === 'hline') expect(added.price).toBe(71_500);
  });

  it('keeps hline active after add', () => {
    const ctx = makeCtx();
    hlineTool.onPointerDown!(ctx);
    expect(ctx.add).toHaveBeenCalledOnce();
    const addedId = ((ctx.add as ReturnType<typeof vi.fn>).mock.calls[0][0] as Drawing).id;
    expect(ctx.setSelected).toHaveBeenCalledWith(addedId);
    expect(ctx.revertToSelectMode).not.toHaveBeenCalled();
  });

  it('new hline inherits color/width/lineStyle from ctx.defaults', () => {
    const ctx = makeCtx();
    ctx.defaults = { color: '#F43F5E', width: 3, lineStyle: 'dashed', fontSize: 13, magnet: false, hiddenAll: false };
    hlineTool.onPointerDown!(ctx);
    const added = (ctx.add as ReturnType<typeof vi.fn>).mock.calls[0][0] as Drawing;
    expect(added.color).toBe('#F43F5E');
    expect(added.width).toBe(3);
    expect(added.lineStyle).toBe('dashed');
  });
});

describe('vlineTool.onPointerDown', () => {
  it('adds a Vline at the cursor time (realMs)', () => {
    const ctx = makeCtx({ canvasXToRealMs: vi.fn(() => 1_700_000_123_000) });
    vlineTool.onPointerDown!(ctx);
    expect(ctx.add).toHaveBeenCalledOnce();
    const added = (ctx.add as ReturnType<typeof vi.fn>).mock.calls[0][0] as Drawing;
    expect(added.kind).toBe('vline');
    if (added.kind === 'vline') expect(added.realMs).toBe(1_700_000_123_000);
  });

  it('does nothing in the empty band where canvasXToRealMs is null', () => {
    const ctx = makeCtx({ canvasXToRealMs: vi.fn(() => null) });
    vlineTool.onPointerDown!(ctx);
    expect(ctx.add).not.toHaveBeenCalled();
  });
});

describe('rectTool — drag commits a 2-corner box', () => {
  it('captures on down, commits a Rect with default fill on up', () => {
    const a: Point = { realMs: 1_000, price: 100 };
    const b: Point = { realMs: 2_000, price: 200 };
    let call = 0;
    const ctx = makeCtx({ pixelToData: vi.fn(() => (call++ === 0 ? a : b)) });
    rectTool.onPointerDown!(ctx);
    expect(ctx.capturePointer).toHaveBeenCalledOnce();
    expect(ctx.rectDraft.current).toMatchObject({ a, paneId: 'candle' });
    rectTool.onPointerUp!(ctx);
    const added = (ctx.add as ReturnType<typeof vi.fn>).mock.calls[0][0] as Drawing;
    expect(added.kind).toBe('rect');
    if (added.kind === 'rect') {
      expect(added.a).toEqual(a);
      expect(added.b).toEqual(b);
      expect(added.fillOpacity).toBeGreaterThan(0);
    }
    expect(ctx.rectDraft.current).toBeNull();
  });

  it('rejects a zero-area rect (same time OR same price)', () => {
    const a: Point = { realMs: 1_000, price: 100 };
    // Same price → degenerate.
    const flat: Point = { realMs: 2_000, price: 100 };
    let call = 0;
    const ctx = makeCtx({ pixelToData: vi.fn(() => (call++ === 0 ? a : flat)) });
    rectTool.onPointerDown!(ctx);
    rectTool.onPointerUp!(ctx);
    expect(ctx.add).not.toHaveBeenCalled();
  });
});

describe('trendlineTool — Shift constrains the endpoint angle', () => {
  it('routes the endpoint through pixel-space angle constraint when shiftKey is set', () => {
    const a: Point = { realMs: 1_000, price: 100 };
    // Anchor projects to (0,0); cursor at px=100,py=8 (near-horizontal) → the
    // constrained pixel is fed back through pixelToData. We assert pixelToData
    // was called with a Y snapped toward the anchor's Y (0), not the raw py.
    const pixelToData = vi.fn((_px: number, _py: number, _paneId: unknown) => a);
    const ctx = makeCtx({
      shiftKey: true,
      pixelToData,
      realMsToCanvasX: vi.fn(() => 0),
      priceToCanvasY: vi.fn(() => 0),
      px: 100,
      py: 8,
      clampYToPane: vi.fn((_id, py) => py),
    });
    ctx.trendlineDraft.current = { a, pointerId: 1, paneId: 'candle' };
    trendlineTool.onPointerMove!(ctx);
    // The constrained call should use a Y close to the anchor's 0, not 8.
    const lastCall = pixelToData.mock.calls.at(-1)!;
    expect(Math.abs(lastCall[1] as number)).toBeLessThan(4); // near-horizontal
  });
});

describe('measureTool — drag commits a 2-endpoint measure', () => {
  it('commits a Measure on drag', () => {
    const a: Point = { realMs: 1_000, price: 100 };
    const b: Point = { realMs: 2_000, price: 200 };
    let call = 0;
    const ctx = makeCtx({ pixelToData: vi.fn(() => (call++ === 0 ? a : b)) });
    measureTool.onPointerDown!(ctx);
    expect(ctx.measureDraft.current).toMatchObject({ a, paneId: 'candle' });
    measureTool.onPointerUp!(ctx);
    const added = (ctx.add as ReturnType<typeof vi.fn>).mock.calls[0][0] as Drawing;
    expect(added.kind).toBe('measure');
  });
});

describe('textTool.onPointerDown', () => {
  it('opens the text editor at the cursor instead of adding directly', () => {
    const at: Point = { realMs: 1_700_000_000_000, price: 70_000 };
    const ctx = makeCtx({ pixelToData: vi.fn(() => at) });
    textTool.onPointerDown!(ctx);
    expect(ctx.beginTextEdit).toHaveBeenCalledWith(at, 'candle', ctx.px, ctx.py);
    expect(ctx.add).not.toHaveBeenCalled(); // commit happens on Enter/blur
  });

  it('falls back to canvasYToPrice/canvasXToRealMs in the empty band (pixelToData null)', () => {
    // Text can still be placed right of the last candle: with pixelToData null,
    // the tool composes a point from the price + time axes.
    const ctx = makeCtx({
      pixelToData: vi.fn(() => null),
      canvasYToPrice: vi.fn(() => 70_000),
      canvasXToRealMs: vi.fn(() => 1_700_000_000_000),
    });
    textTool.onPointerDown!(ctx);
    expect(ctx.beginTextEdit).toHaveBeenCalledWith(
      { realMs: 1_700_000_000_000, price: 70_000 },
      'candle',
      ctx.px,
      ctx.py,
    );
  });

  it('does nothing only when neither axis resolves', () => {
    const ctx = makeCtx({
      pixelToData: vi.fn(() => null),
      canvasYToPrice: vi.fn(() => null),
      canvasXToRealMs: vi.fn(() => null),
    });
    textTool.onPointerDown!(ctx);
    expect(ctx.beginTextEdit).not.toHaveBeenCalled();
  });
});

describe('trendlineTool — drag commits a 2-point segment', () => {
  it('captures pointer on down, commits Trendline on up', () => {
    const a: Point = { realMs: 1_000, price: 100 };
    const b: Point = { realMs: 2_000, price: 200 };
    const ctx = makeCtx({ pixelToData: vi.fn(() => a) });
    trendlineTool.onPointerDown!(ctx);
    expect(ctx.capturePointer).toHaveBeenCalledOnce();
    expect(ctx.trendlineDraft.current).toEqual({ a, pointerId: 1, paneId: 'candle' });

    // Pointer-up at a different location commits the trendline.
    const upCtx = makeCtx({
      pixelToData: vi.fn(() => b),
      trendlineDraft: ctx.trendlineDraft, // share the draft ref
    });
    trendlineTool.onPointerUp!(upCtx);
    expect(upCtx.releasePointer).toHaveBeenCalledOnce();
    expect(upCtx.add).toHaveBeenCalledOnce();
    const committed = (upCtx.add as ReturnType<typeof vi.fn>).mock.calls[0][0] as Drawing;
    expect(committed.kind).toBe('trendline');
    if (committed.kind === 'trendline') {
      expect(committed.a).toEqual(a);
      expect(committed.b).toEqual(b);
    }
    expect(upCtx.trendlineDraft.current).toBeNull();
  });

  it('updates the draft endpoint and requests redraw while dragging', () => {
    const a: Point = { realMs: 1_000, price: 100 };
    const b: Point = { realMs: 2_000, price: 125 };
    const ctx = makeCtx({ pixelToData: vi.fn(() => a) });
    trendlineTool.onPointerDown!(ctx);

    const moveCtx = makeCtx({
      pixelToData: vi.fn(() => b),
      trendlineDraft: ctx.trendlineDraft,
    });
    trendlineTool.onPointerMove!(moveCtx);

    expect(moveCtx.trendlineDraft.current).toEqual({
      a,
      b,
      pointerId: 1,
      paneId: 'candle',
    });
    expect(moveCtx.requestRedraw).toHaveBeenCalledOnce();
  });

  it('rejects zero-length trendlines (click without drag)', () => {
    const p: Point = { realMs: 1_000, price: 100 };
    const ctx = makeCtx({ pixelToData: vi.fn(() => p) });
    trendlineTool.onPointerDown!(ctx);
    // Pointer-up at the SAME location.
    trendlineTool.onPointerUp!(ctx);
    expect(ctx.add).not.toHaveBeenCalled();
  });

  it('keeps trendline active after pointer-up commit', () => {
    const a: Point = { realMs: 1_000, price: 100 };
    const b: Point = { realMs: 2_000, price: 200 };
    const downCtx = makeCtx({ pixelToData: vi.fn(() => a) });
    trendlineTool.onPointerDown!(downCtx);
    const upCtx = makeCtx({
      pixelToData: vi.fn(() => b),
      trendlineDraft: downCtx.trendlineDraft,
    });
    trendlineTool.onPointerUp!(upCtx);
    expect(upCtx.add).toHaveBeenCalledOnce();
    const addedId = ((upCtx.add as ReturnType<typeof vi.fn>).mock.calls[0][0] as Drawing).id;
    expect(upCtx.setSelected).toHaveBeenCalledWith(addedId);
    expect(upCtx.revertToSelectMode).not.toHaveBeenCalled();
  });

  it('new trendline inherits color/width/lineStyle from ctx.defaults', () => {
    const a: Point = { realMs: 1_000, price: 100 };
    const b: Point = { realMs: 2_000, price: 200 };
    const downCtx = makeCtx({ pixelToData: vi.fn(() => a) });
    trendlineTool.onPointerDown!(downCtx);
    const upCtx = makeCtx({
      pixelToData: vi.fn(() => b),
      trendlineDraft: downCtx.trendlineDraft,
    });
    upCtx.defaults = { color: '#F43F5E', width: 3, lineStyle: 'dashed', fontSize: 13, magnet: false, hiddenAll: false };
    trendlineTool.onPointerUp!(upCtx);
    const added = (upCtx.add as ReturnType<typeof vi.fn>).mock.calls[0][0] as Drawing;
    expect(added.color).toBe('#F43F5E');
    expect(added.width).toBe(3);
    expect(added.lineStyle).toBe('dashed');
  });

  it('does NOT call revertToSelectMode when the trendline is zero-length (rejected)', () => {
    const p: Point = { realMs: 1_000, price: 100 };
    const ctx = makeCtx({ pixelToData: vi.fn(() => p) });
    trendlineTool.onPointerDown!(ctx);
    trendlineTool.onPointerUp!(ctx);
    expect(ctx.revertToSelectMode).not.toHaveBeenCalled();
  });
});

describe('eraserTool', () => {
  it('removes the drawing under the cursor', () => {
    const target: Drawing = { id: 'h1', kind: 'hline', price: 100, color: '#14B8A6', width: 1.5, lineStyle: 'solid', paneId: 'candle' };
    const ctx = makeCtx({ hitTestAt: vi.fn(() => target) });
    eraserTool.onPointerDown!(ctx);
    expect(ctx.remove).toHaveBeenCalledWith('h1');
  });

  it('is a no-op when the click misses', () => {
    const ctx = makeCtx({ hitTestAt: vi.fn(() => null) });
    eraserTool.onPointerDown!(ctx);
    expect(ctx.remove).not.toHaveBeenCalled();
  });

  it('never calls revertToSelectMode (continuous-erase flow)', () => {
    const target: Drawing = { id: 'h1', kind: 'hline', price: 100, color: '#14B8A6', width: 1.5, lineStyle: 'solid', paneId: 'candle' };
    const ctx = makeCtx({ hitTestAt: vi.fn(() => target) });
    eraserTool.onPointerDown!(ctx);
    expect(ctx.revertToSelectMode).not.toHaveBeenCalled();
  });
});

describe('pencilTool commit', () => {
  it('keeps pencil active after pointer-up commit', () => {
    const ctx = makeCtx();
    pencilTool.onPointerDown!(ctx);
    ctx.pencilDraft.current!.points.push({ realMs: 1_700_000_000_001, price: 70_010 });
    pencilTool.onPointerUp!(ctx);
    expect(ctx.add).toHaveBeenCalledOnce();
    const addedId = ((ctx.add as ReturnType<typeof vi.fn>).mock.calls[0][0] as Drawing).id;
    expect(ctx.setSelected).toHaveBeenCalledWith(addedId);
    expect(ctx.revertToSelectMode).not.toHaveBeenCalled();
  });

  it('new pencil inherits color/width/lineStyle from ctx.defaults', () => {
    const ctx = makeCtx();
    ctx.defaults = { color: '#F43F5E', width: 3, lineStyle: 'dashed', fontSize: 13, magnet: false, hiddenAll: false };
    pencilTool.onPointerDown!(ctx);
    ctx.pencilDraft.current!.points.push({ realMs: 1_700_000_000_001, price: 70_010 });
    pencilTool.onPointerUp!(ctx);
    const added = (ctx.add as ReturnType<typeof vi.fn>).mock.calls[0][0] as Drawing;
    expect(added.color).toBe('#F43F5E');
    expect(added.width).toBe(3);
    expect(added.lineStyle).toBe('dashed');
  });

  it('does NOT call revertToSelectMode when the pencil has fewer than 2 points', () => {
    const ctx = makeCtx();
    pencilTool.onPointerDown!(ctx);
    pencilTool.onPointerUp!(ctx); // only 1 point in draft
    expect(ctx.revertToSelectMode).not.toHaveBeenCalled();
  });
});

describe('pencilTool throttle', () => {
  it('drops a move that arrives within the 16ms RAF window', () => {
    const ctx = makeCtx();
    pencilTool.onPointerDown!(ctx);
    expect(ctx.pencilDraft.current?.points).toHaveLength(1);
    // First move primes lastFrame to a recent perf.now().
    pencilTool.onPointerMove!(ctx);
    const len1 = ctx.pencilDraft.current!.points.length;
    // A second move on the same ms should be dropped.
    pencilTool.onPointerMove!(ctx);
    expect(ctx.pencilDraft.current!.points.length).toBe(len1);
  });

  it('requests a redraw when a point is appended (live preview)', () => {
    const ctx = makeCtx();
    pencilTool.onPointerDown!(ctx);
    (ctx.requestRedraw as ReturnType<typeof vi.fn>).mockClear();
    // First successful move appends one point and asks for a frame.
    pencilTool.onPointerMove!(ctx);
    expect(ctx.requestRedraw).toHaveBeenCalledOnce();
  });
});

describe('selectTool', () => {
  it('clears selection when click misses', () => {
    const ctx = makeCtx({ hitTestAt: vi.fn(() => null) });
    selectTool.onPointerDown!(ctx);
    expect(ctx.setSelected).toHaveBeenCalledWith(null);
  });

  it('sets selection and initiates body drag on hit', () => {
    const target: Drawing = { id: 'h1', kind: 'hline', price: 100, color: '#14B8A6', width: 1.5, lineStyle: 'solid', paneId: 'candle' };
    const ctx = makeCtx({ hitTestAt: vi.fn(() => target) });
    selectTool.onPointerDown!(ctx);
    expect(ctx.setSelected).toHaveBeenCalledWith('h1');
    expect(ctx.dragRef.current?.kind).toBe('body');
    expect(ctx.capturePointer).toHaveBeenCalledOnce();
  });
});

// ─── empty right band (rightOffset whitespace) ────────────────────────────────
//
// In the chart's empty band to the right of the last candle the time axis can't
// resolve a coordinate, so pixelToData → null. The price scale spans the full
// height regardless of X, so canvasYToPrice still resolves. These tests pin the
// fix: a body drag must run off the price axis alone there, so a price-only
// drawing (hline) keeps dragging instead of freezing. See ADR-0030/0032 area
// and the hoga-ops "hline drag empty area" diagnosis.
describe('selectTool — body drag in the empty right band (pixelToData → null)', () => {
  const hline = (price: number): Drawing => ({
    id: 'h1', kind: 'hline', price, color: '#14B8A6', width: 1.5, lineStyle: 'solid', paneId: 'candle',
  });

  it('starts an hline body drag even where the time axis is unresolvable', () => {
    const target = hline(100);
    const ctx = makeCtx({
      hitTestAt: vi.fn(() => target),       // hline hit-test ignores X → hits in the band
      pixelToData: vi.fn(() => null),       // empty band: coordinateToTime → null
      canvasYToPrice: vi.fn(() => 100),     // price still resolves off the Y axis
    });
    selectTool.onPointerDown!(ctx);
    expect(ctx.setSelected).toHaveBeenCalledWith('h1');
    expect(ctx.dragRef.current?.kind).toBe('body');
    expect((ctx.dragRef.current as { lastRealMs: number | null }).lastRealMs).toBeNull();
    expect((ctx.dragRef.current as { lastPrice: number }).lastPrice).toBe(100);
    expect(ctx.capturePointer).toHaveBeenCalledOnce();
  });

  it('moves an hline by price when dragged into the empty band', () => {
    const target = hline(100);
    const ctx = makeCtx({
      drawings: [target],
      dragRef: { current: { kind: 'body', id: 'h1', lastRealMs: 1_700_000_000_000, lastPrice: 100, pointerId: 1, paneId: 'candle' } },
      pixelToData: vi.fn(() => null),       // pointer now over the empty band
      canvasYToPrice: vi.fn(() => 105),     // cursor Y maps to price 105
      clampYToPane: vi.fn((_id, py) => py),
      priceBoundsForPane: vi.fn(() => ({ top: 200, bottom: 0 })),
    });
    selectTool.onPointerMove!(ctx);
    expect(ctx.update).toHaveBeenCalledWith('h1', { price: 105 });
    // Horizontal stays frozen while X is unresolvable: lastRealMs is preserved,
    // lastPrice advances to the cursor price.
    const drag = ctx.dragRef.current as { lastRealMs: number | null; lastPrice: number };
    expect(drag.lastRealMs).toBe(1_700_000_000_000);
    expect(drag.lastPrice).toBe(105);
  });

  it('moves an hline by price even when the drag started in the empty band (lastRealMs null)', () => {
    const target = hline(100);
    const ctx = makeCtx({
      drawings: [target],
      dragRef: { current: { kind: 'body', id: 'h1', lastRealMs: null, lastPrice: 100, pointerId: 1, paneId: 'candle' } },
      pixelToData: vi.fn(() => null),
      canvasYToPrice: vi.fn(() => 90),
      clampYToPane: vi.fn((_id, py) => py),
      priceBoundsForPane: vi.fn(() => ({ top: 200, bottom: 0 })),
    });
    selectTool.onPointerMove!(ctx);
    expect(ctx.update).toHaveBeenCalledWith('h1', { price: 90 });
  });

  it('still drags normally over candles (regression guard for the data area)', () => {
    const target = hline(100);
    const ctx = makeCtx({
      drawings: [target],
      dragRef: { current: { kind: 'body', id: 'h1', lastRealMs: 1_700_000_000_000, lastPrice: 100, pointerId: 1, paneId: 'candle' } },
      // pixelToData resolves over data (realMs + price); canvasYToPrice agrees on price.
      pixelToData: vi.fn(() => ({ realMs: 1_700_000_060_000, price: 110 })),
      canvasYToPrice: vi.fn(() => 110),
      clampYToPane: vi.fn((_id, py) => py),
      priceBoundsForPane: vi.fn(() => ({ top: 200, bottom: 0 })),
    });
    selectTool.onPointerMove!(ctx);
    expect(ctx.update).toHaveBeenCalledWith('h1', { price: 110 });
    const drag = ctx.dragRef.current as { lastRealMs: number | null };
    expect(drag.lastRealMs).toBe(1_700_000_060_000); // advances when X resolves
  });

  it('moves a trendline endpoint by price in the empty band, preserving its realMs', () => {
    const target: Drawing = {
      id: 't1', kind: 'trendline',
      a: { realMs: 1_700_000_000_000, price: 100 },
      b: { realMs: 1_700_000_600_000, price: 120 },
      color: '#14B8A6', width: 1.5, lineStyle: 'solid', paneId: 'candle',
    };
    const ctx = makeCtx({
      drawings: [target],
      dragRef: { current: { kind: 'handle', id: 't1', endpoint: 'b', pointerId: 1, paneId: 'candle' } },
      pixelToData: vi.fn(() => null),     // empty band
      canvasYToPrice: vi.fn(() => 130),
      clampYToPane: vi.fn((_id, py) => py),
    });
    selectTool.onPointerMove!(ctx);
    expect(ctx.update).toHaveBeenCalledWith('t1', {
      b: { realMs: 1_700_000_600_000, price: 130 },
    });
  });
});

// Regression for the "사각형·측정자 드래그 좌우로 길어지거나 사라짐" bug: body-drag
// used flat Δ-real-ms, so a cursor crossing the day boundary injected the whole
// overnight gap into the delta and stranded rect/measure corners INSIDE the
// gap (off-axis → stretched-to-edge or vanished render). The drag now shifts
// in virtual (gap-compressed) ms, so every vertex must land back on-axis.
describe('selectTool — body drag across a session gap (virtual-domain shift)', () => {
  // Sessions A [0, 1_000_000] and B [10_000_000, 11_000_000]; the 9_000_000
  // overnight gap compresses to 1s of virtual time.
  const axis = createVirtualAxis([
    { date: '20260101', sessionOpenMs: 0, sessionCloseMs: 1_000_000 },
    { date: '20260102', sessionOpenMs: 10_000_000, sessionCloseMs: 11_000_000 },
  ]);
  // 50_000 divides the 1_000_000 session evenly, so every fixture vertex and
  // cursor position sits on the bar grid — like real drawings, whose vertices
  // only ever come from coordinateToTime (bar times).
  const BUCKET = 50_000;
  const dragTime = dragTimeDomain(axis, { lastRealMs: 10_900_000, bucketMs: BUCKET });

  const rect = (): Drawing => ({
    id: 'r1', kind: 'rect',
    a: { realMs: 800_000, price: 100 },
    b: { realMs: 900_000, price: 120 },
    fillOpacity: 0.1,
    color: '#14B8A6', width: 1.5, lineStyle: 'solid', paneId: 'candle',
  });

  it('keeps both rect corners on-axis and on the bar grid when the drag crosses the gap', () => {
    const target = rect();
    const update = vi.fn();
    const ctx = makeCtx({
      drawings: [target],
      dragTime,
      update,
      // Cursor jumped from late session A into session B (crossed the day
      // boundary): 2 bars into B, i.e. +201_000 VIRTUAL ms from 900_000 (the
      // compressed 1s gap rides along in the delta).
      dragRef: { current: { kind: 'body', id: 'r1', lastRealMs: 900_000, lastPrice: 110, pointerId: 1, paneId: 'candle' } },
      pixelToData: vi.fn(() => ({ realMs: 10_100_000, price: 110 })),
      canvasYToPrice: vi.fn(() => 110),
      priceBoundsForPane: vi.fn(() => ({ top: 1_000, bottom: 0 })),
    });
    selectTool.onPointerMove!(ctx);
    expect(update).toHaveBeenCalledOnce();
    const patch = update.mock.calls[0][1] as { a: Point; b: Point };
    // Old real-ms behavior: +9_200_000 real Δ stranded a inside the gap
    // (stretched render). The virtual shift walks bar-space instead: both
    // corners land in session B, still 100_000 (2 bars) apart and ON the bar
    // grid. (Cursor and vertices all cross the same single boundary here, so
    // the gap's +1_000 in Δvirtual cancels; the residue case — vertex crossing
    // while the cursor doesn't — is covered in chartCoordinates.test.ts.)
    expect(patch.a.realMs).toBe(10_000_000);
    expect(patch.b.realMs).toBe(10_100_000);
    expect(axis.contains(patch.a.realMs)).toBe(true);
    expect(axis.contains(patch.b.realMs)).toBe(true);
    expect((patch.a.realMs - 10_000_000) % BUCKET).toBe(0);
    expect((patch.b.realMs - 10_000_000) % BUCKET).toBe(0);
    // Prices untouched (pure horizontal drag).
    expect(patch.a.price).toBe(100);
    expect(patch.b.price).toBe(120);
  });

  it('dragging back restores the original corners exactly (no drift)', () => {
    // Start from the post-gap-crossing state and move the cursor back to the
    // original grab position: the virtual deltas telescope to zero.
    const target: Drawing = {
      ...rect(),
      a: { realMs: 10_000_000, price: 100 },
      b: { realMs: 10_100_000, price: 120 },
    } as Drawing;
    const update = vi.fn();
    const ctx = makeCtx({
      drawings: [target],
      dragTime,
      update,
      dragRef: { current: { kind: 'body', id: 'r1', lastRealMs: 10_100_000, lastPrice: 110, pointerId: 1, paneId: 'candle' } },
      pixelToData: vi.fn(() => ({ realMs: 900_000, price: 110 })),
      canvasYToPrice: vi.fn(() => 110),
      priceBoundsForPane: vi.fn(() => ({ top: 1_000, bottom: 0 })),
    });
    selectTool.onPointerMove!(ctx);
    const patch = update.mock.calls[0][1] as { a: Point; b: Point };
    expect(patch.a.realMs).toBe(800_000);
    expect(patch.b.realMs).toBe(900_000);
  });

  it('caps a leftward overshoot at the axis origin without compressing the shape', () => {
    const target = rect(); // spans virtual [800_000, 900_000]
    const update = vi.fn();
    const ctx = makeCtx({
      drawings: [target],
      dragTime,
      update,
      dragRef: { current: { kind: 'body', id: 'r1', lastRealMs: 900_000, lastPrice: 110, pointerId: 1, paneId: 'candle' } },
      // Cursor swung far left — raw Δvirtual would be -900_000, past the origin.
      pixelToData: vi.fn(() => ({ realMs: 0, price: 110 })),
      canvasYToPrice: vi.fn(() => 110),
      priceBoundsForPane: vi.fn(() => ({ top: 1_000, bottom: 0 })),
    });
    selectTool.onPointerMove!(ctx);
    const patch = update.mock.calls[0][1] as { a: Point; b: Point };
    // Capped at -800_000: a pinned to the origin, b keeps the 100_000 span.
    expect(patch.a.realMs).toBe(0);
    expect(patch.b.realMs).toBe(100_000);
  });

  it('heals a corner stranded in the gap by an old real-ms drag on the next move', () => {
    const target: Drawing = {
      ...rect(),
      // a was left inside the overnight gap by the pre-fix drag path.
      a: { realMs: 5_000_000, price: 100 },
      b: { realMs: 10_100_000, price: 120 },
    } as Drawing;
    const update = vi.fn();
    const ctx = makeCtx({
      drawings: [target],
      dragTime,
      update,
      dragRef: { current: { kind: 'body', id: 'r1', lastRealMs: 10_100_000, lastPrice: 110, pointerId: 1, paneId: 'candle' } },
      // Pure vertical move: Δvirtual = 0, but the round-trip still snaps the
      // stranded corner forward onto session B's open.
      pixelToData: vi.fn(() => ({ realMs: 10_100_000, price: 111 })),
      canvasYToPrice: vi.fn(() => 111),
      priceBoundsForPane: vi.fn(() => ({ top: 1_000, bottom: 0 })),
    });
    selectTool.onPointerMove!(ctx);
    const patch = update.mock.calls[0][1] as { a: Point; b: Point };
    expect(patch.a.realMs).toBe(10_000_000);
    expect(axis.contains(patch.a.realMs)).toBe(true);
    expect(patch.b.realMs).toBe(10_100_000);
  });
});

describe('matchShortcut', () => {
  function key(opts: Partial<KeyboardEvent>): KeyboardEvent {
    return {
      key: 'h',
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      ...opts,
    } as KeyboardEvent;
  }

  it('matches Alt+H → hline', () => {
    expect(matchShortcut(key({ key: 'h', altKey: true }))).toBe('hline');
  });

  it('matches Alt+J → trendline', () => {
    expect(matchShortcut(key({ key: 'j', altKey: true }))).toBe('trendline');
  });

  it('matches Alt+B → pencil', () => {
    expect(matchShortcut(key({ key: 'b', altKey: true }))).toBe('pencil');
  });

  it('matches Alt+E → eraser', () => {
    expect(matchShortcut(key({ key: 'e', altKey: true }))).toBe('eraser');
  });

  it('matches Alt+V → select', () => {
    expect(matchShortcut(key({ key: 'v', altKey: true }))).toBe('select');
  });

  it('is case-insensitive (Alt+Shift+H still matches)', () => {
    expect(matchShortcut(key({ key: 'H', altKey: true, shiftKey: true }))).toBe('hline');
  });

  it('returns null without Alt modifier', () => {
    expect(matchShortcut(key({ key: 'h', altKey: false }))).toBeNull();
  });

  it('returns null with Ctrl modifier (avoid clobbering browser shortcuts)', () => {
    expect(matchShortcut(key({ key: 'h', altKey: true, ctrlKey: true }))).toBeNull();
  });

  it('returns null with Meta modifier', () => {
    expect(matchShortcut(key({ key: 'h', altKey: true, metaKey: true }))).toBeNull();
  });

  it('returns null for unbound keys', () => {
    expect(matchShortcut(key({ key: 'q', altKey: true }))).toBeNull();
  });
});

describe('pane stamping', () => {
  it('hlineTool stamps the paneId resolved from cursor Y', () => {
    const ctx = makeCtx({
      paneIdAtY: vi.fn(() => 'ratio' as const),
    });
    hlineTool.onPointerDown!(ctx);
    const added = (ctx.add as ReturnType<typeof vi.fn>).mock.calls[0][0] as Drawing;
    expect(added.paneId).toBe('ratio');
  });

  it('trendlineTool stamps the paneId of pointer-down on the new drawing', () => {
    const ctx = makeCtx({
      paneIdAtY: vi.fn(() => 'volume' as const),
      pixelToData: vi.fn(() => ({ realMs: 1_700_000_000_000, price: 1000 })),
    });
    trendlineTool.onPointerDown!(ctx);
    // Move pixelToData's mock to return a different point so the
    // zero-length guard doesn't fire.
    (ctx.pixelToData as ReturnType<typeof vi.fn>).mockReturnValue({
      realMs: 1_700_000_001_000,
      price: 2000,
    });
    trendlineTool.onPointerUp!(ctx);
    const added = (ctx.add as ReturnType<typeof vi.fn>).mock.calls[0][0] as Drawing;
    expect(added.paneId).toBe('volume');
  });

  it('pencilTool stamps the paneId of pointer-down on the new drawing', () => {
    const ctx = makeCtx({
      paneIdAtY: vi.fn(() => 'fill-strength' as const),
    });
    pencilTool.onPointerDown!(ctx);
    // Force the move-throttle to pass by mutating lastFrame, then move once.
    if (ctx.pencilDraft.current) ctx.pencilDraft.current.lastFrame = 0;
    (ctx.pixelToData as ReturnType<typeof vi.fn>).mockReturnValue({
      realMs: 1_700_000_001_000,
      price: 0.5,
    });
    pencilTool.onPointerMove!(ctx);
    pencilTool.onPointerUp!(ctx);
    const added = (ctx.add as ReturnType<typeof vi.fn>).mock.calls[0][0] as Drawing;
    expect(added.paneId).toBe('fill-strength');
  });
});

describe('cross-pane drag clamp', () => {
  it('trendline drag clamps Y to the start pane before resolving b.price', () => {
    const ctx = makeCtx({
      paneIdAtY: vi.fn(() => 'volume' as const),
      clampYToPane: vi.fn((_id, _py) => 470),
      pixelToData: vi.fn((_px, py, paneId) => ({
        realMs: 1_700_000_000_000,
        price: paneId === 'volume' && py === 470 ? 100 : -999,
      })),
    });
    trendlineTool.onPointerDown!(ctx);
    ctx.py = 9999;
    trendlineTool.onPointerUp!(ctx);
    expect(ctx.clampYToPane).toHaveBeenCalledWith('volume', 9999);
  });
});
