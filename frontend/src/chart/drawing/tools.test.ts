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
  eraserTool,
  pencilTool,
  selectTool,
  trendlineTool,
  type ToolCtx,
} from './tools';
import type { Drawing, Point } from './types';

function makeCtx(overrides: Partial<ToolCtx> = {}): ToolCtx {
  const defaultPoint: Point = { realMs: 1_700_000_000_000, price: 70_000 };
  const base: ToolCtx = {
    px: 100,
    py: 200,
    pointerId: 1,
    capturePointer: vi.fn(),
    releasePointer: vi.fn(),
    pixelToData: vi.fn(() => defaultPoint),
    realMsToCanvasX: vi.fn(() => 100),
    priceToCanvasY: vi.fn(() => 200),
    hitTestAt: vi.fn(() => null),
    drawings: [],
    selectedId: null,
    accentColor: '#14B8A6',
    trendlineDraft: { current: null },
    pencilDraft: { current: null },
    dragRef: { current: null },
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
    expect(keys).toEqual(['eraser', 'hline', 'pencil', 'select', 'trendline']);
  });

  it('DRAWABLE_TOOLS_ORDER lists only non-select tools', () => {
    expect(DRAWABLE_TOOLS_ORDER).not.toContain('select');
    expect(DRAWABLE_TOOLS_ORDER).toEqual(['hline', 'trendline', 'pencil', 'eraser']);
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

  it('does nothing when pixelToData returns null (price scale unavailable)', () => {
    const ctx = makeCtx({ pixelToData: vi.fn(() => null) });
    hlineTool.onPointerDown!(ctx);
    expect(ctx.add).not.toHaveBeenCalled();
  });
});

describe('trendlineTool — drag commits a 2-point segment', () => {
  it('captures pointer on down, commits Trendline on up', () => {
    const a: Point = { realMs: 1_000, price: 100 };
    const b: Point = { realMs: 2_000, price: 200 };
    const ctx = makeCtx({ pixelToData: vi.fn(() => a) });
    trendlineTool.onPointerDown!(ctx);
    expect(ctx.capturePointer).toHaveBeenCalledOnce();
    expect(ctx.trendlineDraft.current).toEqual({ a, pointerId: 1 });

    // Simulate move to a different (px, py) — onPointerMove is undefined for v1.
    expect(trendlineTool.onPointerMove).toBeUndefined();

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

  it('rejects zero-length trendlines (click without drag)', () => {
    const p: Point = { realMs: 1_000, price: 100 };
    const ctx = makeCtx({ pixelToData: vi.fn(() => p) });
    trendlineTool.onPointerDown!(ctx);
    // Pointer-up at the SAME location.
    trendlineTool.onPointerUp!(ctx);
    expect(ctx.add).not.toHaveBeenCalled();
  });
});

describe('eraserTool', () => {
  it('removes the drawing under the cursor', () => {
    const target: Drawing = { id: 'h1', kind: 'hline', price: 100, color: '#14B8A6', width: 1.5 };
    const ctx = makeCtx({ hitTestAt: vi.fn(() => target) });
    eraserTool.onPointerDown!(ctx);
    expect(ctx.remove).toHaveBeenCalledWith('h1');
  });

  it('is a no-op when the click misses', () => {
    const ctx = makeCtx({ hitTestAt: vi.fn(() => null) });
    eraserTool.onPointerDown!(ctx);
    expect(ctx.remove).not.toHaveBeenCalled();
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
    const target: Drawing = { id: 'h1', kind: 'hline', price: 100, color: '#14B8A6', width: 1.5 };
    const ctx = makeCtx({ hitTestAt: vi.fn(() => target) });
    selectTool.onPointerDown!(ctx);
    expect(ctx.setSelected).toHaveBeenCalledWith('h1');
    expect(ctx.dragRef.current?.kind).toBe('body');
    expect(ctx.capturePointer).toHaveBeenCalledOnce();
  });
});
