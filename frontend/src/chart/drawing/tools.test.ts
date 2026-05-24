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
  matchShortcut,
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
    commitAndRevert: vi.fn(),
    releasePointer: vi.fn(),
    pixelToData: vi.fn(() => defaultPoint),
    realMsToCanvasX: vi.fn(() => 100),
    priceToCanvasY: vi.fn(() => 200),
    hitTestAt: vi.fn(() => null),
    paneIdAtY: vi.fn(() => 'candle' as const),
    clampYToPane: vi.fn((_id, py) => py),
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

  it('calls commitAndRevert with the new id after add', () => {
    const ctx = makeCtx();
    hlineTool.onPointerDown!(ctx);
    expect(ctx.commitAndRevert).toHaveBeenCalledOnce();
    const addedId = ((ctx.add as ReturnType<typeof vi.fn>).mock.calls[0][0] as Drawing).id;
    expect(ctx.commitAndRevert).toHaveBeenCalledWith(addedId);
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

  it('calls commitAndRevert with the new trendline id on pointer-up', () => {
    const a: Point = { realMs: 1_000, price: 100 };
    const b: Point = { realMs: 2_000, price: 200 };
    const downCtx = makeCtx({ pixelToData: vi.fn(() => a) });
    trendlineTool.onPointerDown!(downCtx);
    const upCtx = makeCtx({
      pixelToData: vi.fn(() => b),
      trendlineDraft: downCtx.trendlineDraft,
    });
    trendlineTool.onPointerUp!(upCtx);
    expect(upCtx.commitAndRevert).toHaveBeenCalledOnce();
    const addedId = ((upCtx.add as ReturnType<typeof vi.fn>).mock.calls[0][0] as Drawing).id;
    expect(upCtx.commitAndRevert).toHaveBeenCalledWith(addedId);
  });

  it('does NOT call commitAndRevert when the trendline is zero-length (rejected)', () => {
    const p: Point = { realMs: 1_000, price: 100 };
    const ctx = makeCtx({ pixelToData: vi.fn(() => p) });
    trendlineTool.onPointerDown!(ctx);
    trendlineTool.onPointerUp!(ctx);
    expect(ctx.commitAndRevert).not.toHaveBeenCalled();
  });
});

describe('eraserTool', () => {
  it('removes the drawing under the cursor', () => {
    const target: Drawing = { id: 'h1', kind: 'hline', price: 100, color: '#14B8A6', width: 1.5, paneId: 'candle' };
    const ctx = makeCtx({ hitTestAt: vi.fn(() => target) });
    eraserTool.onPointerDown!(ctx);
    expect(ctx.remove).toHaveBeenCalledWith('h1');
  });

  it('is a no-op when the click misses', () => {
    const ctx = makeCtx({ hitTestAt: vi.fn(() => null) });
    eraserTool.onPointerDown!(ctx);
    expect(ctx.remove).not.toHaveBeenCalled();
  });

  it('never calls commitAndRevert (continuous-erase flow)', () => {
    const target: Drawing = { id: 'h1', kind: 'hline', price: 100, color: '#14B8A6', width: 1.5, paneId: 'candle' };
    const ctx = makeCtx({ hitTestAt: vi.fn(() => target) });
    eraserTool.onPointerDown!(ctx);
    expect(ctx.commitAndRevert).not.toHaveBeenCalled();
  });
});

describe('pencilTool commit', () => {
  it('calls commitAndRevert with the new pencil id on pointer-up', () => {
    const ctx = makeCtx();
    pencilTool.onPointerDown!(ctx);
    // Manually seed a second point so the >=2 commit guard passes.
    ctx.pencilDraft.current!.points.push({ realMs: 1_700_000_000_001, price: 70_010 });
    pencilTool.onPointerUp!(ctx);
    expect(ctx.commitAndRevert).toHaveBeenCalledOnce();
    const addedId = ((ctx.add as ReturnType<typeof vi.fn>).mock.calls[0][0] as Drawing).id;
    expect(ctx.commitAndRevert).toHaveBeenCalledWith(addedId);
  });

  it('does NOT call commitAndRevert when the pencil has fewer than 2 points', () => {
    const ctx = makeCtx();
    pencilTool.onPointerDown!(ctx);
    pencilTool.onPointerUp!(ctx); // only 1 point in draft
    expect(ctx.commitAndRevert).not.toHaveBeenCalled();
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
    const target: Drawing = { id: 'h1', kind: 'hline', price: 100, color: '#14B8A6', width: 1.5, paneId: 'candle' };
    const ctx = makeCtx({ hitTestAt: vi.fn(() => target) });
    selectTool.onPointerDown!(ctx);
    expect(ctx.setSelected).toHaveBeenCalledWith('h1');
    expect(ctx.dragRef.current?.kind).toBe('body');
    expect(ctx.capturePointer).toHaveBeenCalledOnce();
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

  it('matches Alt+T → trendline', () => {
    expect(matchShortcut(key({ key: 't', altKey: true }))).toBe('trendline');
  });

  it('matches Alt+P → pencil', () => {
    expect(matchShortcut(key({ key: 'p', altKey: true }))).toBe('pencil');
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
