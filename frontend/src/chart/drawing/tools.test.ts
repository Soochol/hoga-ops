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
  PENCIL_MIN_SAMPLE_PX,
  type DrawingToolSpec,
  type ToolCtx,
} from './tools';
import type { Drawing, Point, Rect } from './types';
import { createVirtualAxis } from '../../util/virtualAxis';
import { dragBarDomain } from './chartCoordinates';

function makeCtx(overrides: Partial<ToolCtx> = {}): ToolCtx {
  const defaultPoint: Point = { realMs: 1_700_000_000_000, price: 70_000 };
  const base: ToolCtx = {
    px: 100,
    py: 200,
    // Empty = "the platform coalesced nothing", so the pencil falls back to
    // px/py. Tests that exercise multi-sample capture pass their own list.
    coalesced: [],
    // Unknown pitch by default → sub-bar offsets resolve to 0, i.e. the
    // bar-anchored geometry every pre-subX assertion in this file expects.
    barPx: vi.fn(() => null),
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
    hitTestUnlockedAt: vi.fn(() => null),
    paneIdAtY: vi.fn(() => 'candle' as const),
    clampYToPane: vi.fn((_id, py) => py),
    priceBoundsForPane: vi.fn(() => ({ top: 100_000, bottom: 0 })),
    // Identity bar domain: ordinal == real. Gap-aware behavior is covered by
    // the dragBarDomain tests (chartCoordinates.test.ts) and the dedicated
    // boundary-crossing drag tests below.
    dragBars: {
      toBar: (ms: number) => ms,
      toReal: (b: number) => b,
      originBar: -Infinity,
      barSized: true,
    },
    drawings: [],
    selectedId: null,
    selectedIds: [],
    drawingsInRect: vi.fn(() => []),
    defaults: { color: '#14B8A6', width: 2, lineStyle: 'solid' as const, fontSize: 13, fillOpacity: 0.1 },
    shiftKey: false,
    trendlineDraft: { current: null },
    pencilDraft: { current: null },
    rectDraft: { current: null },
    measureDraft: { current: null },
    marqueeDraft: { current: null },
    dragRef: { current: null },
    // Off by default so every pre-existing assertion measures the unsnapped
    // geometry it was written against; the alignment tests opt in explicitly.
    alignSnapEnabled: false,
    setAlignGuides: vi.fn(),
    beginTextEdit: vi.fn(),
    requestRedraw: vi.fn(),
    add: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    updateMany: vi.fn(),
    setSelected: vi.fn(),
    toggleSelected: vi.fn(),
    addToSelection: vi.fn(),
  };
  const ctx = { ...base, ...overrides };
  // `hitTestUnlockedAt` 을 따로 주지 않은 테스트는 `hitTestAt` 의 답에서 잠긴 것만
  // 걸러 받는다 — 도형이 하나뿐인 대부분의 테스트에서 제품과 같은 답이다.
  //
  // ⚠ 제품은 **목록을** 거르고 여기서는 **승자를** 거른다. 둘은 정확히 겹침
  // 케이스에서 갈리므로(위의 잠긴 도형이 아래 살아 있는 것을 가린다), 그 케이스를
  // 재는 테스트는 두 함수를 **명시적으로** 갈라 줘야 한다.
  if (!('hitTestUnlockedAt' in overrides)) {
    ctx.hitTestUnlockedAt = (px, py) => {
      const h = ctx.hitTestAt(px, py);
      return h != null && h.locked !== true ? h : null;
    };
  }
  return ctx;
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
    // 커밋 후 도구는 살아 있고(2026-07-01 요청), **선택은 하지 않는다**
    // (2026-08-08 결정 — 그리기 모드는 항상 그린다).
    expect(ctx.setSelected).not.toHaveBeenCalled();
    expect(ctx.revertToSelectMode).not.toHaveBeenCalled();
  });

  it('new hline inherits color/width/lineStyle from ctx.defaults', () => {
    const ctx = makeCtx();
    ctx.defaults = { color: '#F43F5E', width: 3, lineStyle: 'dashed', fontSize: 13, fillOpacity: 0.1 };
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
    // 커밋 후 도구는 살아 있고(2026-07-01 요청), **선택은 하지 않는다**
    // (2026-08-08 결정 — 그리기 모드는 항상 그린다).
    expect(upCtx.setSelected).not.toHaveBeenCalled();
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
    upCtx.defaults = { color: '#F43F5E', width: 3, lineStyle: 'dashed', fontSize: 13, fillOpacity: 0.1 };
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
    // 커밋 후 도구는 살아 있고(2026-07-01 요청), **선택은 하지 않는다**
    // (2026-08-08 결정 — 그리기 모드는 항상 그린다).
    expect(ctx.setSelected).not.toHaveBeenCalled();
    expect(ctx.revertToSelectMode).not.toHaveBeenCalled();
  });

  it('new pencil inherits color/width/lineStyle from ctx.defaults', () => {
    const ctx = makeCtx();
    ctx.defaults = { color: '#F43F5E', width: 3, lineStyle: 'dashed', fontSize: 13, fillOpacity: 0.1 };
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

describe('pencilTool 서브-봉 해상도', () => {
  // 저장되는 realMs 는 **봉**밖에 못 가리킨다 — 캡처가 타는
  // `coordinateToTime` 이 float 봉 인덱스의 `Math.ceil` 이라서다. 커서가 그
  // 봉 안에서 어디였는지는 subX 가 아니면 복원할 방법이 없고, 없으면
  // 스트로크가 봉 폭만큼의 계단이 된다(실측: 축소 15.8px, 확대 28.2px).
  it('봉 앵커가 버린 픽셀 잔차를 봉 폭 분수로 싣는다', () => {
    const ctx = makeCtx({
      barPx: vi.fn(() => 20),
      realMsToCanvasX: vi.fn(() => 92), // 앵커 봉은 92px, 커서는 100px
    });
    pencilTool.onPointerDown!(ctx);
    expect(ctx.pencilDraft.current!.subX[0]).toBeCloseTo(0.4); // (100-92)/20
  });

  it('봉 폭을 모르면 subX 는 0 — 봉 앵커 동작으로 퇴화한다', () => {
    const ctx = makeCtx({
      barPx: vi.fn(() => null),
      realMsToCanvasX: vi.fn(() => 92),
    });
    pencilTool.onPointerDown!(ctx);
    expect(ctx.pencilDraft.current!.subX[0]).toBe(0);
  });

  it('앵커가 축 밖이라 재투영이 안 되면 subX 는 0', () => {
    const ctx = makeCtx({
      barPx: vi.fn(() => 20),
      realMsToCanvasX: vi.fn(() => null),
    });
    pencilTool.onPointerDown!(ctx);
    expect(ctx.pencilDraft.current!.subX[0]).toBe(0);
  });

  it('커밋된 stroke 의 subX 는 points 와 같은 길이다', () => {
    const ctx = makeCtx({ barPx: vi.fn(() => 20), realMsToCanvasX: vi.fn(() => 92) });
    pencilTool.onPointerDown!(ctx);
    ctx.px += 10;
    pencilTool.onPointerMove!(ctx);
    ctx.px += 10;
    pencilTool.onPointerMove!(ctx);
    pencilTool.onPointerUp!(ctx);
    const added = (ctx.add as ReturnType<typeof vi.fn>).mock.calls[0][0] as Drawing;
    if (added.kind !== 'pencil') throw new Error('expected a pencil');
    expect(added.subX).toHaveLength(added.points.length);
  });

  it('단순화가 points 와 subX 를 같은 인덱스로 함께 솎는다', () => {
    // 두 배열을 따로 필터하면 여기서 어긋난다 — 그러면 남은 점들이 남의
    // 오프셋을 쓰게 되고, 스트로크가 통째로 옆으로 밀린다.
    const anchors = [1_700_000_000_000, 1_700_000_060_000, 1_700_000_120_000];
    let i = -1;
    const ctx = makeCtx({
      barPx: vi.fn(() => 10),
      pixelToData: vi.fn(() => {
        i += 1;
        return { realMs: anchors[Math.min(i, anchors.length - 1)], price: 70_000 };
      }),
      realMsToCanvasX: vi.fn((ms: number) => (ms - anchors[0]) / 1000), // 0 / 60 / 120
      priceToCanvasY: vi.fn(() => 200),
    });
    ctx.px = 1; // 앵커 0 → 0.1
    pencilTool.onPointerDown!(ctx);
    ctx.px = 62; // 앵커 60 → 0.2
    pencilTool.onPointerMove!(ctx);
    ctx.px = 123; // 앵커 120 → 0.3
    pencilTool.onPointerMove!(ctx);
    pencilTool.onPointerUp!(ctx);
    const added = (ctx.add as ReturnType<typeof vi.fn>).mock.calls[0][0] as Drawing;
    if (added.kind !== 'pencil') throw new Error('expected a pencil');
    // 오프셋까지 더한 픽셀이 1/62/123 로 정확히 일직선 → 가운데는 RDP 가 버린다.
    expect(added.points.map((p) => p.realMs)).toEqual([anchors[0], anchors[2]]);
    expect(added.subX).toEqual([0.1, 0.3]);
  });

  it('subX 는 소수 3자리로 반올림해 저장한다 (용량 예산)', () => {
    const ctx = makeCtx({ barPx: vi.fn(() => 3), realMsToCanvasX: vi.fn(() => 99) });
    pencilTool.onPointerDown!(ctx); // (100-99)/3 = 0.3333…
    ctx.px += 10;
    pencilTool.onPointerMove!(ctx);
    pencilTool.onPointerUp!(ctx);
    const added = (ctx.add as ReturnType<typeof vi.fn>).mock.calls[0][0] as Drawing;
    if (added.kind !== 'pencil') throw new Error('expected a pencil');
    expect(added.subX![0]).toBe(0.333);
  });
});

describe('pencilTool 샘플 게이트', () => {
  // 종전엔 16ms 시계 게이트였다(초당 ~62점 상한). 빠르게 그을수록 성겨지는
  // 게 문제라 **이동 거리** 게이트로 바꿨다 — 멈춘 포인터는 이벤트가 아무리
  // 많이 와도 점을 안 늘리고, 빠른 포인터는 상한 없이 다 잡는다.
  it('제자리 move 는 점을 늘리지 않는다', () => {
    const ctx = makeCtx();
    pencilTool.onPointerDown!(ctx);
    expect(ctx.pencilDraft.current?.points).toHaveLength(1);
    pencilTool.onPointerMove!(ctx); // 커서가 pointer-down 자리 그대로
    pencilTool.onPointerMove!(ctx);
    expect(ctx.pencilDraft.current!.points).toHaveLength(1);
  });

  it('PENCIL_MIN_SAMPLE_PX 를 넘긴 이동은 점을 추가한다', () => {
    const ctx = makeCtx();
    pencilTool.onPointerDown!(ctx);
    // 경계 바로 아래 → 버린다. 임계를 지우면 이 단언이 깨진다.
    ctx.px += PENCIL_MIN_SAMPLE_PX / 2;
    pencilTool.onPointerMove!(ctx);
    expect(ctx.pencilDraft.current!.points).toHaveLength(1);
    // 경계 위 → 잡는다.
    ctx.px += PENCIL_MIN_SAMPLE_PX * 2;
    pencilTool.onPointerMove!(ctx);
    expect(ctx.pencilDraft.current!.points).toHaveLength(2);
  });

  it('한 이벤트에 합쳐진 coalesced 샘플을 전부 잡는다', () => {
    // 브라우저는 고주사율 포인터의 여러 샘플을 pointermove 하나로 합쳐서
    // 준다. 이벤트 좌표만 읽으면 나머지를 버리는 것이고, 그게 곧
    // 프레임 해상도(≈60Hz)로 스트로크가 깎이는 원인이다.
    const ctx = makeCtx({
      coalesced: [
        { px: 110, py: 210 },
        { px: 120, py: 220 },
        { px: 130, py: 230 },
      ],
    });
    pencilTool.onPointerDown!(ctx);
    pencilTool.onPointerMove!(ctx);
    expect(ctx.pencilDraft.current!.points).toHaveLength(4); // down 1 + 합쳐진 3
  });

  it('requests a redraw when a point is appended (live preview)', () => {
    const ctx = makeCtx();
    pencilTool.onPointerDown!(ctx);
    (ctx.requestRedraw as ReturnType<typeof vi.fn>).mockClear();
    ctx.px += 10;
    pencilTool.onPointerMove!(ctx);
    expect(ctx.requestRedraw).toHaveBeenCalledOnce();
  });

  it('redraw 는 샘플 수가 아니라 이벤트 수를 따른다', () => {
    // 샘플마다 부르면 프레임당 수십 번이 된다. lwc 가 다음 프레임으로
    // 합치긴 하지만, 프리뷰 갱신 단위는 이벤트라는 것을 여기서 못박는다.
    const ctx = makeCtx({
      coalesced: [
        { px: 110, py: 210 },
        { px: 120, py: 220 },
        { px: 130, py: 230 },
      ],
    });
    pencilTool.onPointerDown!(ctx);
    (ctx.requestRedraw as ReturnType<typeof vi.fn>).mockClear();
    pencilTool.onPointerMove!(ctx);
    expect(ctx.requestRedraw).toHaveBeenCalledOnce();
  });

  it('아무 샘플도 안 잡히면 redraw 도 안 부른다', () => {
    const ctx = makeCtx();
    pencilTool.onPointerDown!(ctx);
    (ctx.requestRedraw as ReturnType<typeof vi.fn>).mockClear();
    pencilTool.onPointerMove!(ctx); // 제자리
    expect(ctx.requestRedraw).not.toHaveBeenCalled();
  });
});

describe('그리기 모드는 항상 그린다 — 커밋해도 선택하지 않는다', () => {
  // 한때 커밋 시 방금 그린 도형을 선택하고, 그 위에서 시작한 press 를 이동으로
  // 넘기는 게이트가 있었다(#1227). 사용자가 써 본 뒤 2026-08-08 에 폐기했다 —
  // 선택 효과를 없애고 방금 그린 자리 위에 곧바로 다음 도형을 그리는 쪽을 택했다.
  // 이동·스타일 변경은 select 모드의 일이다.
  const target: Drawing = {
    id: 'p1',
    kind: 'pencil',
    points: [
      { realMs: 1_700_000_000_000, price: 70_000 },
      { realMs: 1_700_000_060_000, price: 70_500 },
    ],
    color: '#14B8A6',
    width: 2,
    lineStyle: 'solid',
    paneId: 'candle',
  };

  /** 매 호출마다 다른 점을 돌려주는 ctx — 추세선/사각형은 두 점이 같으면 생성을
   *  거부하므로(0 길이/0 넓이) 고정 점짜리 기본 stub 으로는 "그려진다"를 못 잰다. */
  function movingCtx(overrides: Partial<ToolCtx> = {}): ToolCtx {
    let n = 0;
    return makeCtx({
      pixelToData: vi.fn(() => {
        n += 1;
        return { realMs: 1_700_000_000_000 + n * 60_000, price: 70_000 + n * 10 };
      }),
      ...overrides,
    });
  }

  /** 도구별 "하나 그리기". hline/vline 은 down 한 번이 곧 생성이고, 나머지는
   *  down→move→up 이 필요하다. 선택적 호출인 것이 의도다 — 1-클릭 도구엔 move/up
   *  핸들러가 아예 없다(게이트를 걷어내며 래퍼가 붙여 주던 것도 사라졌다). */
  function drawOne(tool: DrawingToolSpec, ctx: ToolCtx): void {
    tool.onPointerDown?.(ctx);
    // 커서를 실제로 옮긴 뒤 move 한다. 연필은 픽셀 이동이
    // PENCIL_MIN_SAMPLE_PX 미만이면 샘플을 버리므로(제자리 포인터가 점을
    // 쌓지 않게), 좌표가 고정이면 점이 1개에 머물러 커밋 자체가 일어나지
    // 않는다. 나머지 도구는 좌표 대신 pixelToData 결과만 읽어 무해하다.
    ctx.px += 20;
    ctx.py += 20;
    tool.onPointerMove?.(ctx);
    tool.onPointerUp?.(ctx);
  }

  const DRAWING: ReadonlyArray<readonly [string, DrawingToolSpec]> = [
    ['hline', hlineTool],
    ['vline', vlineTool],
    ['trendline', trendlineTool],
    ['rect', rectTool],
    ['pencil', pencilTool],
  ];

  for (const [name, tool] of DRAWING) {
    it(`${name}: 커밋해도 setSelected 를 부르지 않는다`, () => {
      const ctx = movingCtx();
      drawOne(tool, ctx);
      expect(ctx.add).toHaveBeenCalledOnce();
      expect(ctx.setSelected).not.toHaveBeenCalled();
    });

    it(`${name}: 선택된 도형 위에서 시작해도 이동이 아니라 그려진다`, () => {
      // 게이트가 살아 있으면 여기서 dragRef 가 서고 add 가 안 불린다.
      const ctx = movingCtx({
        drawings: [target],
        selectedId: 'p1',
        hitTestAt: vi.fn(() => target),
      });
      drawOne(tool, ctx);
      expect(ctx.dragRef.current).toBeNull();
      expect(ctx.add).toHaveBeenCalledOnce();
    });
  }

  it('측정자는 예외다 — 커밋 시 select 로 돌아가므로 그 선택은 그리기를 막지 않는다', () => {
    const ctx = movingCtx();
    drawOne(measureTool, ctx);
    expect(ctx.add).toHaveBeenCalledOnce();
    expect(ctx.revertToSelectMode).toHaveBeenCalledOnce();
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
    const started = ctx.dragRef.current as { startBar: number | null; startPrice: number };
    expect(started.startBar).toBeNull();
    expect(started.startPrice).toBe(100);
    expect(ctx.capturePointer).toHaveBeenCalledOnce();
  });

  it('moves an hline by price when dragged into the empty band', () => {
    const target = hline(100);
    const ctx = makeCtx({
      drawings: [target],
      dragRef: { current: { kind: 'body', id: 'h1', origin: target, startBar: 1_700_000_000_000, startPrice: 100, lastBar: 1_700_000_000_000, pointerId: 1, paneId: 'candle' } },
      pixelToData: vi.fn(() => null),       // pointer now over the empty band
      canvasYToPrice: vi.fn(() => 105),     // cursor Y maps to price 105
      clampYToPane: vi.fn((_id, py) => py),
      priceBoundsForPane: vi.fn(() => ({ top: 200, bottom: 0 })),
    });
    selectTool.onPointerMove!(ctx);
    expect(ctx.update).toHaveBeenCalledWith('h1', { price: 105 });
    // Horizontal stays frozen while X is unresolvable (lastBar keeps its last
    // resolvable value), and the ANCHORS never move — under absolute
    // anchoring they are set once at grab time and read every frame.
    const drag = ctx.dragRef.current as {
      lastBar: number | null; startBar: number | null; startPrice: number;
    };
    expect(drag.lastBar).toBe(1_700_000_000_000);
    expect(drag.startBar).toBe(1_700_000_000_000);
    expect(drag.startPrice).toBe(100);
  });

  it('moves an hline by price even when the drag started in the empty band (lastRealMs null)', () => {
    const target = hline(100);
    const ctx = makeCtx({
      drawings: [target],
      dragRef: { current: { kind: 'body', id: 'h1', origin: target, startBar: null, startPrice: 100, lastBar: null, pointerId: 1, paneId: 'candle' } },
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
      dragRef: { current: { kind: 'body', id: 'h1', origin: target, startBar: 1_700_000_000_000, startPrice: 100, lastBar: 1_700_000_000_000, pointerId: 1, paneId: 'candle' } },
      // pixelToData resolves over data (realMs + price); canvasYToPrice agrees on price.
      pixelToData: vi.fn(() => ({ realMs: 1_700_000_060_000, price: 110 })),
      canvasYToPrice: vi.fn(() => 110),
      clampYToPane: vi.fn((_id, py) => py),
      priceBoundsForPane: vi.fn(() => ({ top: 200, bottom: 0 })),
    });
    selectTool.onPointerMove!(ctx);
    expect(ctx.update).toHaveBeenCalledWith('h1', { price: 110 });
    const drag = ctx.dragRef.current as { lastBar: number | null };
    expect(drag.lastBar).toBe(1_700_000_060_000); // advances when X resolves
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
  const dragBars = dragBarDomain(axis, { lastRealMs: 10_900_000, bucketMs: BUCKET });

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
      dragBars,
      update,
      // Cursor jumped from late session A into session B (crossed the day
      // boundary): 2 bars into B, i.e. +201_000 VIRTUAL ms from 900_000 (the
      // compressed 1s gap rides along in the delta).
      dragRef: { current: { kind: 'body', id: 'r1', origin: target, startBar: dragBars.toBar(900_000), startPrice: 110, lastBar: dragBars.toBar(900_000), pointerId: 1, paneId: 'candle' } },
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

  it('dragging out and back restores the original corners exactly (no drift)', () => {
    // A real round trip, driven as two moves off ONE grab: out across the day
    // boundary, then back to the grab position. Under absolute anchoring both
    // frames are measured from the same snapshot, so the return is exact by
    // construction rather than by two deltas cancelling.
    const target = rect();
    const update = vi.fn();
    const cursor = { realMs: 10_100_000, price: 110 };
    const ctx = makeCtx({
      drawings: [target],
      dragBars,
      update,
      dragRef: { current: { kind: 'body', id: 'r1', origin: target, startBar: dragBars.toBar(900_000), startPrice: 110, lastBar: dragBars.toBar(900_000), pointerId: 1, paneId: 'candle' } },
      pixelToData: vi.fn(() => cursor),
      canvasYToPrice: vi.fn(() => cursor.price),
      priceBoundsForPane: vi.fn(() => ({ top: 1_000, bottom: 0 })),
    });
    selectTool.onPointerMove!(ctx);
    const out = update.mock.calls[0][1] as { a: Point; b: Point };
    expect(out.a.realMs).toBe(10_000_000);
    expect(out.b.realMs).toBe(10_100_000);

    cursor.realMs = 900_000;
    selectTool.onPointerMove!(ctx);
    const back = update.mock.calls[1][1] as { a: Point; b: Point };
    expect(back.a.realMs).toBe(800_000);
    expect(back.b.realMs).toBe(900_000);
  });

  it('caps a leftward overshoot at the axis origin without compressing the shape', () => {
    const target = rect(); // spans virtual [800_000, 900_000]
    const update = vi.fn();
    const ctx = makeCtx({
      drawings: [target],
      dragBars,
      update,
      dragRef: { current: { kind: 'body', id: 'r1', origin: target, startBar: dragBars.toBar(900_000), startPrice: 110, lastBar: dragBars.toBar(900_000), pointerId: 1, paneId: 'candle' } },
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
      dragBars,
      update,
      dragRef: { current: { kind: 'body', id: 'r1', origin: target, startBar: dragBars.toBar(10_100_000), startPrice: 110, lastBar: dragBars.toBar(10_100_000), pointerId: 1, paneId: 'candle' } },
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
    // Move the cursor past PENCIL_MIN_SAMPLE_PX so the sample is captured
    // (pointer-down seeded lastPx/lastPy at the same 100/200).
    ctx.px = 140;
    ctx.py = 260;
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

// ── 잠금 (ADR-0164) ────────────────────────────────────────────────────────
describe('잠긴 드로잉의 도구 게이트', () => {
  const lockedHline: Drawing = {
    id: 'h1', kind: 'hline', price: 70_000, color: '#14B8A6',
    width: 2, lineStyle: 'solid', paneId: 'candle', locked: true,
  };
  const lockedTrendline: Drawing = {
    id: 't1', kind: 'trendline',
    a: { realMs: 1_700_000_000_000, price: 70_000 },
    b: { realMs: 1_700_000_600_000, price: 71_000 },
    color: '#14B8A6', width: 2, lineStyle: 'solid', paneId: 'candle', locked: true,
  };

  // 잠긴 도형의 **선택**은 이제 selectTool 이 아니라 window mousedown 리스너의
  // 몫이다(`resolveSelectModeMouseDown`) — 게이트가 'none' 이라 이 오버레이는
  // 그 클릭을 애초에 못 받는다. 여기서 고르면 담당 구역이 겹친다.
  it('잠긴 도형만 있으면 아무것도 고르지 않는다 — 선택은 window 리스너의 몫', () => {
    const ctx = makeCtx({ drawings: [lockedHline], hitTestAt: vi.fn(() => lockedHline) });
    selectTool.onPointerDown!(ctx);

    expect(ctx.setSelected).toHaveBeenCalledWith(null);
  });

  // ⚠ 겹침 케이스. 게이트가 오버레이에 포인터를 준 이유는 "잠기지 않은 게 여기
  // 있다" 이므로 도구도 그것을 집어야 한다. 전체 목록으로 고르면 위의 잠긴 도형이
  // 최상단으로 이겨서, **잡지도 못하고 차트 팬도 안 되는** 죽은 클릭이 된다.
  it('잠긴 도형이 위에 겹쳐 있어도 아래 잠기지 않은 도형을 집는다', () => {
    const live: Drawing = { ...lockedHline, id: 'live', locked: false };
    const ctx = makeCtx({
      drawings: [live, lockedHline],
      hitTestAt: vi.fn(() => lockedHline), // 최상단은 잠긴 것
      hitTestUnlockedAt: vi.fn(() => live), // 게이트가 보는 것은 아래 살아 있는 것
    });
    selectTool.onPointerDown!(ctx);

    expect(ctx.setSelected).toHaveBeenCalledWith('live');
  });

  it('겹침에서 집은 도형은 실제로 드래그가 시작된다', () => {
    const live: Drawing = { ...lockedHline, id: 'live', locked: false };
    const ctx = makeCtx({
      drawings: [live, lockedHline],
      hitTestAt: vi.fn(() => lockedHline),
      hitTestUnlockedAt: vi.fn(() => live),
    });
    selectTool.onPointerDown!(ctx);

    expect(ctx.dragRef.current).toMatchObject({ kind: 'body', id: 'live' });
    expect(ctx.capturePointer).toHaveBeenCalled();
  });

  it('잠긴 도형은 본체 드래그를 시작하지 않는다', () => {
    const ctx = makeCtx({ drawings: [lockedHline], hitTestAt: vi.fn(() => lockedHline) });
    selectTool.onPointerDown!(ctx);

    expect(ctx.dragRef.current).toBeNull();
    expect(ctx.capturePointer).not.toHaveBeenCalled();
  });

  // 핸들 분기는 hitTestAt 보다 **앞**에 있어서 별도 게이트가 필요하다 — 커서가
  // 끝점 위에 있으면 본체 히트 판정에 닿기 전에 handle 드래그가 서 버린다.
  it('잠긴 트렌드라인은 끝점 핸들 드래그도 시작하지 않는다', () => {
    const ctx = makeCtx({
      px: 100, py: 200, // 아래 투영 스텁이 a 끝점을 정확히 (100,200) 에 놓는다
      drawings: [lockedTrendline],
      selectedId: 't1',
      realMsToCanvasX: vi.fn(() => 100),
      priceToCanvasY: vi.fn(() => 200),
    });
    selectTool.onPointerDown!(ctx);

    expect(ctx.dragRef.current).toBeNull();
  });

  it('지우개는 잠긴 도형을 통과한다', () => {
    const ctx = makeCtx({ hitTestAt: vi.fn(() => lockedHline) });
    eraserTool.onPointerDown!(ctx);

    expect(ctx.remove).not.toHaveBeenCalled();
  });

  it('지우개는 잠기지 않은 도형은 그대로 지운다', () => {
    const unlocked: Drawing = { ...lockedHline, locked: false };
    const ctx = makeCtx({ hitTestAt: vi.fn(() => unlocked) });
    eraserTool.onPointerDown!(ctx);

    expect(ctx.remove).toHaveBeenCalledWith('h1');
  });
});

// ─── selectTool — 다중 선택 ────────────────────────────────────────────────
//
// Shift 는 select 모드에서 비어 있던 modifier 다(그리기 중 각도 스냅에만 쓰였다).
// 여기서 셋을 고정한다: Shift+클릭 = 토글, Shift+빈 곳 = 마퀴, 멤버를 잡으면
// 집합 전체가 움직이되 **끌지 않고 놓으면** 그 하나로 접힌다.
describe('selectTool — 다중 선택', () => {
  const hline = (id: string, price: number): Drawing => ({
    id, kind: 'hline', price, color: '#14B8A6', width: 1.5, lineStyle: 'solid', paneId: 'candle',
  });

  it('Shift+클릭은 선택을 교체하지 않고 토글한다', () => {
    const target = hline('h1', 100);
    const ctx = makeCtx({ shiftKey: true, hitTestAt: vi.fn(() => target) });
    selectTool.onPointerDown!(ctx);
    expect(ctx.toggleSelected).toHaveBeenCalledWith('h1');
    expect(ctx.setSelected).not.toHaveBeenCalled();
    // 토글은 선택을 고르는 제스처지 이동이 아니다 — 드래그를 세우면 고르려다
    // 옮겨 버린 상태를 되돌려야 한다.
    expect(ctx.dragRef.current).toBeNull();
  });

  it('Shift+빈 곳 누르기는 마퀴를 시작한다', () => {
    const ctx = makeCtx({ shiftKey: true, px: 10, py: 20, hitTestAt: vi.fn(() => null) });
    selectTool.onPointerDown!(ctx);
    expect(ctx.marqueeDraft.current).toEqual({ ax: 10, ay: 20, bx: 10, by: 20, pointerId: 1 });
    expect(ctx.capturePointer).toHaveBeenCalledOnce();
    // 빈 곳 Shift+클릭이 선택을 지우지 않는다 — 모아 둔 집합을 날리면 안 된다.
    expect(ctx.setSelected).not.toHaveBeenCalled();
  });

  it('마퀴 드래그가 사각형을 넓히고 다시 그리게 한다', () => {
    const ctx = makeCtx({
      px: 90, py: 120,
      marqueeDraft: { current: { ax: 10, ay: 20, bx: 10, by: 20, pointerId: 1 } },
    });
    selectTool.onPointerMove!(ctx);
    expect(ctx.marqueeDraft.current).toMatchObject({ bx: 90, by: 120 });
    expect(ctx.requestRedraw).toHaveBeenCalled();
  });

  it('마퀴를 놓으면 감싼 도형들이 선택에 더해진다', () => {
    const found = [hline('h1', 100), hline('h2', 200)];
    const ctx = makeCtx({
      px: 90, py: 120,
      marqueeDraft: { current: { ax: 10, ay: 20, bx: 90, by: 120, pointerId: 1 } },
      drawingsInRect: vi.fn(() => found),
    });
    selectTool.onPointerUp!(ctx);
    expect(ctx.drawingsInRect).toHaveBeenCalledWith({ x1: 10, y1: 20, x2: 90, y2: 120 });
    expect(ctx.addToSelection).toHaveBeenCalledWith(['h1', 'h2']);
    expect(ctx.marqueeDraft.current).toBeNull();
  });

  // 빗나간 Shift+클릭(사실상 0px 상자)은 아무것도 고르지 않는다. 히트 테스트를
  // 아예 돌리지 않는 것이 요점 — 1px 상자에 걸린 것이 "무작위 선택"으로 보인다.
  it('너무 작은 마퀴는 아무것도 고르지 않는다', () => {
    const ctx = makeCtx({
      marqueeDraft: { current: { ax: 10, ay: 20, bx: 12, by: 21, pointerId: 1 } },
      drawingsInRect: vi.fn(() => [hline('h1', 100)]),
    });
    selectTool.onPointerUp!(ctx);
    expect(ctx.drawingsInRect).not.toHaveBeenCalled();
    expect(ctx.addToSelection).not.toHaveBeenCalled();
  });

  it('여러 개가 선택된 상태에서 멤버를 잡으면 그룹 드래그가 선다 — 선택은 그대로', () => {
    const target = hline('h1', 100);
    const ctx = makeCtx({
      hitTestAt: vi.fn(() => target),
      drawings: [target, hline('h2', 200)],
      selectedIds: ['h1', 'h2'],
    });
    selectTool.onPointerDown!(ctx);
    expect(ctx.dragRef.current?.kind).toBe('body-multi');
    // 그룹도 단일 드래그처럼 그랩 시점 스냅샷을 든다 — `ids` 가 아니라 도형 자체.
    const grabbed = ctx.dragRef.current as { origins: readonly Drawing[] };
    expect(grabbed.origins.map((d) => d.id)).toEqual(['h1', 'h2']);
    expect(ctx.setSelected).not.toHaveBeenCalled();
  });

  it('한 개만 선택된 상태에서는 예전처럼 단건 body 드래그다', () => {
    const target = hline('h1', 100);
    const ctx = makeCtx({ hitTestAt: vi.fn(() => target), selectedIds: ['h1'] });
    selectTool.onPointerDown!(ctx);
    expect(ctx.dragRef.current?.kind).toBe('body');
  });

  it('집합 밖의 도형을 잡으면 단일 선택으로 바뀐다', () => {
    const other = hline('h9', 900);
    const ctx = makeCtx({ hitTestAt: vi.fn(() => other), selectedIds: ['h1', 'h2'] });
    selectTool.onPointerDown!(ctx);
    expect(ctx.setSelected).toHaveBeenCalledWith('h9');
    expect(ctx.dragRef.current?.kind).toBe('body');
  });

  // `origins` 는 그랩 시점 스냅샷이므로 override 된 `drawings` 를 그대로 따라간다.
  // 둘을 따로 두면 스냅샷이 스토어와 다른 세상을 가리켜 테스트가 실제 경로를
  // 재지 못한다.
  const multiDrag = (over: Partial<ToolCtx> = {}) => {
    const drawings = over.drawings ?? [hline('h1', 100), hline('h2', 200)];
    return makeCtx({
      drawings,
      dragRef: {
        current: {
          kind: 'body-multi',
          origins: drawings,
          startBar: 1_700_000_000_000, lastBar: 1_700_000_000_000,
          startPx: 100, startPy: 200, pressedId: 'h1', moved: false,
          pointerId: 1, paneId: 'candle',
        },
      },
      ...over,
    });
  };

  // slop: 손 떨림 1~2px 이 이동(과 되돌리기 단계)을 쓰면, 그 뒤의 "클릭으로
  // 접기"가 이미 일어난 변이를 설명해야 한다. 넘기 전엔 아무 패치도 내지 않는다.
  it('slop 안의 미세한 움직임은 아무것도 옮기지 않는다', () => {
    const ctx = multiDrag({ px: 101, py: 201 });
    selectTool.onPointerMove!(ctx);
    expect(ctx.updateMany).not.toHaveBeenCalled();
  });

  it('slop 을 넘으면 집합 전체가 한 번의 배치로 움직인다', () => {
    const ctx = multiDrag({ px: 100, py: 210 });
    selectTool.onPointerMove!(ctx);
    expect(ctx.updateMany).toHaveBeenCalledOnce();
    expect(
      (ctx.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0]
        .map((p: { id: string }) => p.id),
    ).toEqual(['h1', 'h2']);
    expect((ctx.dragRef.current as { moved: boolean }).moved).toBe(true);
  });

  it('잠긴 멤버는 그룹 이동에서 빠진다', () => {
    const ctx = multiDrag({
      px: 100, py: 210,
      drawings: [hline('h1', 100), { ...hline('h2', 200), locked: true }],
    });
    selectTool.onPointerMove!(ctx);
    expect(
      (ctx.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0]
        .map((p: { id: string }) => p.id),
    ).toEqual(['h1']);
  });

  it('끌지 않고 놓으면 집합이 눌린 하나로 접힌다', () => {
    const ctx = multiDrag();
    selectTool.onPointerUp!(ctx);
    expect(ctx.setSelected).toHaveBeenCalledWith('h1');
    expect(ctx.dragRef.current).toBeNull();
  });

  it('실제로 끌었다면 놓아도 집합이 유지된다', () => {
    const ctx = multiDrag({ px: 100, py: 210 });
    selectTool.onPointerMove!(ctx);
    selectTool.onPointerUp!(ctx);
    expect(ctx.setSelected).not.toHaveBeenCalled();
  });

  // 핸들은 단일 선택 전용이다. ToolCtx.selectedId 가 "정확히 하나일 때만" 이라
  // 다중에서는 값 자체가 null 이고, 핸들 분기가 구조적으로 닫힌다.
  it('다중 선택에서는 추세선 끝점 핸들을 잡지 않는다', () => {
    const t: Drawing = {
      id: 't1', kind: 'trendline',
      a: { realMs: 1_700_000_000_000, price: 100 },
      b: { realMs: 1_700_000_600_000, price: 200 },
      color: '#14B8A6', width: 1.5, lineStyle: 'solid', paneId: 'candle',
    };
    const ctx = makeCtx({
      // 커서가 끝점 a 바로 위(스텁 투영이 100,200 을 준다).
      px: 100, py: 200,
      drawings: [t],
      selectedId: null,          // 다중 → primary 없음
      selectedIds: ['t1', 'x2'],
      hitTestAt: vi.fn(() => t),
    });
    selectTool.onPointerDown!(ctx);
    expect(ctx.dragRef.current?.kind).toBe('body-multi');
  });
});

// ── shape-to-shape alignment snapping ──────────────────────────────────────
//
// Coordinate stubs are LINEAR here (1 000 ms = 1 px, 1 price = 1 px) rather
// than the constant-returning defaults, because these assertions are about
// pixel distances: with a constant converter every candidate sits 0 px away
// and the threshold would never be exercised.
describe('selectTool — alignment snapping (rect body drag)', () => {
  const linear = {
    realMsToCanvasX: (ms: number) => ms / 1_000,
    priceToCanvasY: (p: number) => 1_000 - p,
  };

  /** Neighbour: x px 100..200, y px 500..400. */
  const neighbour = (over: Partial<Drawing> = {}): Drawing =>
    ({
      id: 'n1', kind: 'rect',
      a: { realMs: 100_000, price: 500 },
      b: { realMs: 200_000, price: 600 },
      fillOpacity: 0.1, color: '#F43F5E', width: 1.5, lineStyle: 'solid', paneId: 'candle',
      ...over,
    }) as Drawing;

  /** Dragged shape. Width (220 000) deliberately differs from the neighbour's
   *  so exactly ONE anchor pair lands inside the threshold — equal widths make
   *  min↔min and max↔max tie, and the tie-break would decide the test. */
  const moving = (): Drawing => ({
    id: 'm1', kind: 'rect',
    a: { realMs: 300_000, price: 300 },
    b: { realMs: 520_000, price: 400 },
    fillOpacity: 0.1, color: '#14B8A6', width: 1.5, lineStyle: 'solid', paneId: 'candle',
  });

  /** A drag context whose cursor the caller can move between pointermoves.
   *  Spies arrive through `over`, the same way every other test in this file
   *  passes them — a dedicated parameter typed off `vi.fn`'s return loses the
   *  contextual typing that makes a bare `vi.fn()` fit a ToolCtx slot. */
  function dragCtx(
    opts: {
      origin: Drawing;
      others: Drawing[];
      cursorBar: { v: number };
      alignSnapEnabled?: boolean;
    },
    over: Partial<ToolCtx> = {},
  ) {
    return makeCtx({
      drawings: [opts.origin, ...opts.others],
      ...linear,
      alignSnapEnabled: opts.alignSnapEnabled ?? true,
      dragRef: {
        current: {
          kind: 'body', id: opts.origin.id, origin: opts.origin,
          startBar: 0, startPrice: 350, lastBar: 0, pointerId: 1, paneId: 'candle',
        },
      },
      pixelToData: vi.fn(() => ({ realMs: opts.cursorBar.v, price: 350 })),
      canvasYToPrice: vi.fn(() => 350),
      priceBoundsForPane: vi.fn(() => ({ top: 10_000, bottom: 0 })),
      ...over,
    });
  }

  it('pulls the dragged rect flush onto a neighbour edge', () => {
    // Cursor moves -195 000 bars: the left edge lands at 105 000 (px 105),
    // 5 px from the neighbour's left (px 100) — inside the 8 px threshold.
    const update = vi.fn();
    const ctx = dragCtx(
      { origin: moving(), others: [neighbour()], cursorBar: { v: -195_000 } },
      { update },
    );
    selectTool.onPointerMove!(ctx);
    const patch = update.mock.calls[0][1] as { a: Point; b: Point };
    expect(patch.a.realMs).toBe(100_000);          // snapped, not 105 000
    expect(patch.b.realMs).toBe(320_000);          // width preserved
    expect(patch.a.price).toBe(300);               // Y untouched — axes independent
    expect(patch.b.price).toBe(400);
  });

  it('does not snap when the magnet is off', () => {
    const update = vi.fn();
    const ctx = dragCtx(
      { origin: moving(), others: [neighbour()], cursorBar: { v: -195_000 }, alignSnapEnabled: false },
      { update },
    );
    selectTool.onPointerMove!(ctx);
    const patch = update.mock.calls[0][1] as { a: Point };
    expect(patch.a.realMs).toBe(105_000);
  });

  it('NEVER lets the snap correction reach the drag anchor', () => {
    // The invariant absolute anchoring exists for. Frame 1 snaps (-5 000 of
    // pull); frame 2 returns the cursor to the grab point. If that pull had
    // been folded into startBar, the shape would come back 5 000 short.
    const update = vi.fn();
    const cursorBar = { v: -195_000 };
    const ctx = dragCtx({ origin: moving(), others: [neighbour()], cursorBar }, { update });
    selectTool.onPointerMove!(ctx);
    expect((update.mock.calls[0][1] as { a: Point }).a.realMs).toBe(100_000);

    cursorBar.v = 0;
    selectTool.onPointerMove!(ctx);
    const back = update.mock.calls[1][1] as { a: Point; b: Point };
    expect(back.a.realMs).toBe(300_000);
    expect(back.b.realMs).toBe(520_000);
    const drag = ctx.dragRef.current as { startBar: number | null; startPrice: number };
    expect(drag.startBar).toBe(0);
    expect(drag.startPrice).toBe(350);
  });

  it('aligns to a LOCKED neighbour — a lock forbids editing, not measuring', () => {
    const update = vi.fn();
    const ctx = dragCtx(
      { origin: moving(), others: [neighbour({ locked: true })], cursorBar: { v: -195_000 } },
      { update },
    );
    selectTool.onPointerMove!(ctx);
    expect((update.mock.calls[0][1] as { a: Point }).a.realMs).toBe(100_000);
  });

  it('ignores a rect on another pane (its price domain is a different unit)', () => {
    const update = vi.fn();
    const ctx = dragCtx(
      { origin: moving(), others: [neighbour({ paneId: 'volume' })], cursorBar: { v: -195_000 } },
      { update },
    );
    selectTool.onPointerMove!(ctx);
    expect((update.mock.calls[0][1] as { a: Point }).a.realMs).toBe(105_000);
  });

  it('ignores itself — a shape cannot align to where it used to be', () => {
    const update = vi.fn();
    const origin = moving();
    // The store still holds the pre-drag geometry, so without the self-exclude
    // the shape would snap back onto its own starting edge.
    const ctx = dragCtx({ origin, others: [], cursorBar: { v: -1_000 } }, { update });
    selectTool.onPointerMove!(ctx);
    expect((update.mock.calls[0][1] as { a: Point }).a.realMs).toBe(299_000);
  });

  it('leaves non-rect shapes alone (only rectangles carry edges to align)', () => {
    const hline: Drawing = {
      id: 'h9', kind: 'hline', price: 350,
      color: '#14B8A6', width: 1.5, lineStyle: 'solid', paneId: 'candle',
    };
    const update = vi.fn();
    const ctx = dragCtx({ origin: hline, others: [neighbour()], cursorBar: { v: -195_000 } }, { update });
    selectTool.onPointerMove!(ctx);
    expect(update).toHaveBeenCalledWith('h9', { price: 350 });
  });

  it('publishes a guide while snapped and clears it on pointer-up', () => {
    const setAlignGuides = vi.fn();
    const ctx = dragCtx(
      { origin: moving(), others: [neighbour()], cursorBar: { v: -195_000 } },
      { setAlignGuides },
    );
    selectTool.onPointerMove!(ctx);
    expect(setAlignGuides).toHaveBeenCalledWith([
      // Vertical line at the aligned time, spanning both boxes' prices.
      { axis: 'x', paneId: 'candle', at: 100_000, from: 300, to: 600 },
    ]);
    selectTool.onPointerUp!(ctx);
    expect(setAlignGuides).toHaveBeenLastCalledWith([]);
  });

  it('publishes an empty guide list on a move that snaps nothing', () => {
    // Otherwise a guide drawn on an earlier frame would stay painted.
    const setAlignGuides = vi.fn();
    const ctx = dragCtx(
      { origin: moving(), others: [neighbour()], cursorBar: { v: 0 } },
      { setAlignGuides },
    );
    selectTool.onPointerMove!(ctx);
    expect(setAlignGuides).toHaveBeenCalledWith([]);
  });
});

describe('selectTool — 우측 확장 사각형의 오른쪽 코너 핸들', () => {
  // realMsToCanvasX = ms/1000, priceToCanvasY = 1000-price
  // → a(100_000, 300) = (100, 700), b(200_000, 400) = (200, 600).
  const linear = {
    realMsToCanvasX: (ms: number) => ms / 1_000,
    priceToCanvasY: (p: number) => 1_000 - p,
  };
  const rect: Drawing = {
    id: 'r1', kind: 'rect',
    a: { realMs: 100_000, price: 300 },
    b: { realMs: 200_000, price: 400 },
    fillOpacity: 0.1, color: '#14B8A6', width: 2, lineStyle: 'solid', paneId: 'candle',
  };

  /** 오른쪽 위 코너(200, 600) 위에서의 pointerDown. */
  function downOnRightCorner(target: Drawing) {
    const ctx = makeCtx({
      ...linear,
      drawings: [target],
      selectedId: target.id,
      px: 200,
      py: 600,
    });
    selectTool.onPointerDown!(ctx);
    return ctx;
  }

  it('평소엔 오른쪽 코너에서 rect-handle 드래그가 시작된다', () => {
    const ctx = downOnRightCorner(rect);
    expect(ctx.dragRef.current).toMatchObject({ kind: 'rect-handle', msKey: 'b', priceKey: 'b' });
  });

  it('확장 중이면 오른쪽 코너를 잡지 않는다 — 렌더가 그 핸들을 안 그리기 때문', () => {
    const ctx = downOnRightCorner({ ...rect, extendRight: true });
    expect(ctx.dragRef.current).not.toMatchObject({ kind: 'rect-handle' });
  });

  it('확장 중에도 **왼쪽** 코너는 그대로 잡힌다 — 왼쪽 변은 여전히 사용자 것이다', () => {
    const ctx = makeCtx({
      ...linear,
      drawings: [{ ...rect, extendRight: true }],
      selectedId: rect.id,
      px: 100,
      py: 700, // a 코너
    });
    selectTool.onPointerDown!(ctx);
    expect(ctx.dragRef.current).toMatchObject({ kind: 'rect-handle', msKey: 'a', priceKey: 'a' });
  });

  it('코너를 가로질러 끈 사각형(a 가 b 의 오른쪽)에서도 **오른쪽** 두 개가 빠진다', () => {
    // a.x = 200, b.x = 100 — 저장 키로 판정하면 여기서 엉뚱한 쪽이 사라진다.
    const crossed: Drawing = {
      ...rect,
      a: { realMs: 200_000, price: 300 },
      b: { realMs: 100_000, price: 400 },
      extendRight: true,
    };
    const right = makeCtx({ ...linear, drawings: [crossed], selectedId: crossed.id, px: 200, py: 700 });
    selectTool.onPointerDown!(right);
    expect(right.dragRef.current).not.toMatchObject({ kind: 'rect-handle' });

    const left = makeCtx({ ...linear, drawings: [crossed], selectedId: crossed.id, px: 100, py: 600 });
    selectTool.onPointerDown!(left);
    expect(left.dragRef.current).toMatchObject({ kind: 'rect-handle', msKey: 'b' });
  });
});

describe('selectTool — alignment snapping (rect corner resize)', () => {
  const linear = {
    realMsToCanvasX: (ms: number) => ms / 1_000,
    priceToCanvasY: (p: number) => 1_000 - p,
  };
  const resized: Drawing = {
    id: 'r9', kind: 'rect',
    a: { realMs: 100_000, price: 300 },
    b: { realMs: 200_000, price: 400 },
    fillOpacity: 0.1, color: '#14B8A6', width: 1.5, lineStyle: 'solid', paneId: 'candle',
  };
  const neighbour: Drawing = {
    id: 'n9', kind: 'rect',
    a: { realMs: 300_000, price: 500 },
    b: { realMs: 400_000, price: 600 },
    fillOpacity: 0.1, color: '#F43F5E', width: 1.5, lineStyle: 'solid', paneId: 'candle',
  };

  function handleCtx(over: Partial<ToolCtx> = {}) {
    return makeCtx({
      drawings: [resized, neighbour],
      ...linear,
      alignSnapEnabled: true,
      dragRef: {
        current: {
          kind: 'rect-handle', id: 'r9', msKey: 'b', priceKey: 'b',
          pointerId: 1, paneId: 'candle',
        },
      },
      // Corner cursor 5 px shy of the neighbour's left edge and 5 px shy of
      // its top — both inside the threshold, on both axes.
      pixelToData: vi.fn(() => ({ realMs: 295_000, price: 505 })),
      canvasYToPrice: vi.fn(() => 505),
      ...over,
    });
  }

  it('snaps the moving corner to a neighbour on both axes', () => {
    const update = vi.fn();
    const ctx = handleCtx({ update });
    selectTool.onPointerMove!(ctx);
    expect(update).toHaveBeenCalledWith('r9', { b: { realMs: 300_000, price: 500 } });
  });

  it('holds X still where the time axis cannot resolve it', () => {
    // In the empty band the caller keeps the corner's stored realMs; a magnet
    // that moved X anyway would read as the shape jumping on its own.
    //
    // The neighbour is placed 5 px from the corner's STORED x (200 000 → px
    // 200) rather than the default one 100 px away: the gate can only be
    // measured where a snap would otherwise fire. With the far neighbour this
    // test passed with the gate deleted.
    const near: Drawing = {
      ...neighbour,
      a: { realMs: 205_000, price: 500 },
      b: { realMs: 305_000, price: 600 },
    } as Drawing;
    const update = vi.fn();
    const ctx = handleCtx({
      update,
      drawings: [resized, near],
      pixelToData: vi.fn(() => null),
    });
    selectTool.onPointerMove!(ctx);
    // Y still snaps (505 → 500); X stays on the stored 200 000.
    expect(update).toHaveBeenCalledWith('r9', { b: { realMs: 200_000, price: 500 } });
  });

  it('does not snap when the magnet is off', () => {
    const update = vi.fn();
    const ctx = handleCtx({ update, alignSnapEnabled: false });
    selectTool.onPointerMove!(ctx);
    expect(update).toHaveBeenCalledWith('r9', { b: { realMs: 295_000, price: 505 } });
  });
});

describe('rectTool — alignment snapping while drawing', () => {
  const linear = {
    realMsToCanvasX: (ms: number) => ms / 1_000,
    priceToCanvasY: (p: number) => 1_000 - p,
  };
  const neighbour: Drawing = {
    id: 'n8', kind: 'rect',
    a: { realMs: 300_000, price: 500 },
    b: { realMs: 400_000, price: 600 },
    fillOpacity: 0.1, color: '#F43F5E', width: 1.5, lineStyle: 'solid', paneId: 'candle',
  };

  it('aligns the first corner on pointer-down', () => {
    const ctx = makeCtx({
      drawings: [neighbour],
      ...linear,
      alignSnapEnabled: true,
      pixelToData: vi.fn(() => ({ realMs: 295_000, price: 505 })),
    });
    rectTool.onPointerDown!(ctx);
    expect(ctx.rectDraft.current?.a).toEqual({ realMs: 300_000, price: 500 });
  });

  it('commits the SNAPPED corner, matching what the preview showed', () => {
    const add = vi.fn();
    const ctx = makeCtx({
      drawings: [neighbour],
      ...linear,
      alignSnapEnabled: true,
      add,
      rectDraft: {
        current: { a: { realMs: 100_000, price: 300 }, pointerId: 1, paneId: 'candle' },
      },
      pixelToData: vi.fn(() => ({ realMs: 295_000, price: 505 })),
    });
    rectTool.onPointerUp!(ctx);
    expect(add).toHaveBeenCalledOnce();
    const created = add.mock.calls[0][0] as { a: Point; b: Point };
    expect(created.b).toEqual({ realMs: 300_000, price: 500 });
    // …and the guides go with the gesture.
    expect(ctx.setAlignGuides).toHaveBeenLastCalledWith([]);
  });
});

// ── 그룹 정렬 스냅 (다중 선택 body 드래그) ─────────────────────────────────
//
// 좌표 스텁은 여기서도 선형이다(1 000ms = 1px, 1price = 1px). 그룹은 수직
// 델타를 PIXEL 로 나르므로 두 축의 단위가 실제로 다르고, 그 변환이 맞는지를
// 재는 것이 이 블록의 절반이다.
describe('selectTool — 그룹 정렬 스냅', () => {
  const linear = {
    realMsToCanvasX: (ms: number) => ms / 1_000,
    priceToCanvasY: (p: number) => 1_000 - p,
    canvasYToPrice: (y: number) => 1_000 - y,
  };

  const box = (
    id: string, x1: number, y1: number, x2: number, y2: number,
    over: Partial<Rect> = {},
  ): Drawing => ({
    id, kind: 'rect',
    a: { realMs: x1, price: y1 }, b: { realMs: x2, price: y2 },
    fillOpacity: 0.1, color: '#14B8A6', width: 1.5, lineStyle: 'solid', paneId: 'candle',
    ...over,
  }) as Drawing;

  /** 이웃: x px 100~200, y px 500~400. */
  const neighbour = () => box('n1', 100_000, 500, 200_000, 600);
  /** 그룹 두 장. 합쳐서 bbox x 300 000~520 000, y price 300~400. */
  const m1 = () => box('m1', 300_000, 300, 400_000, 350);
  const m2 = () => box('m2', 450_000, 360, 520_000, 400);

  function groupCtx(opts: {
    members: Drawing[];
    others?: Drawing[];
    cursor: { px: number; py: number };
    alignSnapEnabled?: boolean;
  }, over: Partial<ToolCtx> = {}) {
    const members = opts.members;
    const ctx = makeCtx({
      drawings: [...members, ...(opts.others ?? [])],
      ...linear,
      alignSnapEnabled: opts.alignSnapEnabled ?? true,
      // 앵커는 원점(bar 0 · py 0). 커서 위치가 곧 총 델타가 된다.
      canvasXToRealMs: vi.fn(() => opts.cursor.px * 1_000),
      priceBoundsForPane: vi.fn(() => ({ top: 10_000, bottom: -10_000 })),
      dragRef: {
        current: {
          kind: 'body-multi', origins: members,
          startBar: 0, lastBar: 0,
          startPx: 0, startPy: 0, pressedId: members[0].id, moved: true,
          pointerId: 1, paneId: 'candle',
        },
      },
      ...over,
    });
    // px/py 는 **살아 있는 참조**여야 한다. 값으로 굳히면 왕복 테스트에서 커서를
    // 되돌려도 ctx 는 첫 위치에 머물러, 앵커 오염이 없는데도 있는 것처럼 보인다
    // (실제로 처음에 그렇게 틀렸다 — X 는 함수 스텁이라 따라가고 Y 만 멈췄다).
    if (!('px' in over)) Object.defineProperty(ctx, 'px', { get: () => opts.cursor.px });
    if (!('py' in over)) Object.defineProperty(ctx, 'py', { get: () => opts.cursor.py });
    return ctx;
  }

  /** updateMany 로 나간 패치를 id → patch 로. */
  const patches = (ctx: ToolCtx) => {
    const calls = (ctx.updateMany as ReturnType<typeof vi.fn>).mock.calls;
    return new Map(
      (calls[0][0] as { id: string; patch: Partial<Rect> }[]).map((e) => [e.id, e.patch]),
    );
  };

  it('그룹의 바운딩 박스가 이웃 모서리에 붙는다 — 멤버는 대형을 유지한 채', () => {
    // 커서 -195 000 바 · -95px: bbox 왼쪽이 이웃 왼쪽에서 5px, 위가 이웃
    // 아래에서 5px. 두 축 모두 임계 안이라 함께 붙는다.
    const ctx = groupCtx({
      members: [m1(), m2()], others: [neighbour()],
      cursor: { px: -195_000 / 1_000, py: -95 },
    });
    selectTool.onPointerMove!(ctx);
    const p = patches(ctx);
    // X: 왼쪽 변이 이웃의 왼쪽과 같은 값. Y: 그룹 아래가 이웃 위와 맞닿는다.
    expect(p.get('m1')!.a).toEqual({ realMs: 100_000, price: 400 });
    expect(p.get('m1')!.b).toEqual({ realMs: 200_000, price: 450 });
    // 대형 유지: m2 는 m1 과 같은 델타만큼 움직였다.
    expect(p.get('m2')!.a).toEqual({ realMs: 250_000, price: 460 });
    expect(p.get('m2')!.b).toEqual({ realMs: 320_000, price: 500 });
  });

  it('자석이 꺼져 있으면 붙지 않는다', () => {
    const ctx = groupCtx({
      members: [m1(), m2()], others: [neighbour()],
      cursor: { px: -195_000 / 1_000, py: -95 }, alignSnapEnabled: false,
    });
    selectTool.onPointerMove!(ctx);
    expect(patches(ctx).get('m1')!.a).toEqual({ realMs: 105_000, price: 395 });
  });

  it('그룹은 자기 멤버에게 붙지 않는다', () => {
    // 5 000바(=5px)만 끈다. 멤버가 후보에 남아 있으면 m1 의 원래 왼쪽 변이
    // 정확히 5px 거리라 그리로 되붙어 제자리처럼 보인다.
    const ctx = groupCtx({
      members: [m1(), m2()], others: [], cursor: { px: -5, py: 0 },
    });
    selectTool.onPointerMove!(ctx);
    expect(patches(ctx).get('m1')!.a).toEqual({ realMs: 295_000, price: 300 });
  });

  it('페인이 섞인 그룹은 붙지 않는다 — 가격을 견줄 공통 축이 없다', () => {
    const ctx = groupCtx({
      members: [m1(), box('m2', 450_000, 360, 520_000, 400, { paneId: 'volume' })],
      others: [neighbour()],
      cursor: { px: -195_000 / 1_000, py: -95 },
    });
    selectTool.onPointerMove!(ctx);
    expect(patches(ctx).get('m1')!.a).toEqual({ realMs: 105_000, price: 395 });
  });

  it('사각형이 없는 그룹은 붙지 않는다 — 정렬은 모서리 위에 정의된다', () => {
    const line: Drawing = {
      id: 'l1', kind: 'hline', price: 300,
      color: '#14B8A6', width: 1.5, lineStyle: 'solid', paneId: 'candle',
    };
    const ctx = groupCtx({
      members: [line], others: [neighbour()], cursor: { px: -195_000 / 1_000, py: -95 },
    });
    selectTool.onPointerMove!(ctx);
    expect(patches(ctx).get('l1')).toEqual({ price: 395 });
  });

  it('클램프에 잘릴 스냅은 채택하지 않는다 — 가이드가 거짓말을 하느니', () => {
    // 경계를 **상한**으로 잡는다. 하한으로 조이면 원본 가격이 이미 범위 밖이 되어
    // `clampDPriceForDrawing` 이 곧바로 0 을 돌려주고(드래그 freeze), 스냅이
    // 잘리는 상황 자체가 만들어지지 않는다 — 처음에 그렇게 틀렸다.
    //
    // 498 은 스냅 전(m2 의 위쪽이 495 까지)은 통과시키고 스냅 후(500)는 자르는
    // 자리다. 잘린 채 붙이면 가이드만 "맞닿았다"고 말하게 된다.
    const ctx = groupCtx(
      { members: [m1(), m2()], others: [neighbour()],
        cursor: { px: -195_000 / 1_000, py: -95 } },
      { priceBoundsForPane: vi.fn(() => ({ top: 498, bottom: -10_000 })) },
    );
    selectTool.onPointerMove!(ctx);
    // 축은 전부-아니면-전무라 X 스냅도 함께 빠진다.
    const a = patches(ctx).get('m1')!.a as Point;
    expect(a.realMs).toBe(105_000);
    expect(ctx.setAlignGuides).toHaveBeenLastCalledWith([]);
  });

  it('스냅 보정이 그룹 앵커로 새지 않는다 — 왕복하면 원위치', () => {
    const cursor = { px: -195_000 / 1_000, py: -95 };
    const ctx = groupCtx({ members: [m1(), m2()], others: [neighbour()], cursor });
    selectTool.onPointerMove!(ctx);
    const first = (ctx.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0] as
      { id: string; patch: Partial<Rect> }[];
    expect(first.find((e) => e.id === 'm1')!.patch.a).toEqual({ realMs: 100_000, price: 400 });

    // 커서를 그랩 지점으로 되돌린다. 앵커가 오염됐다면 여기서 어긋난다.
    cursor.px = 0; cursor.py = 0;
    selectTool.onPointerMove!(ctx);
    const back = (ctx.updateMany as ReturnType<typeof vi.fn>).mock.calls[1][0] as
      { id: string; patch: Partial<Rect> }[];
    expect(back.find((e) => e.id === 'm1')!.patch.a).toEqual({ realMs: 300_000, price: 300 });
    expect(back.find((e) => e.id === 'm2')!.patch.b).toEqual({ realMs: 520_000, price: 400 });
    const drag = ctx.dragRef.current as { startBar: number | null; startPy: number };
    expect(drag.startBar).toBe(0);
    expect(drag.startPy).toBe(0);
  });

  it('붙는 동안 가이드를 내고, 붙지 않는 프레임엔 빈 배열을 낸다', () => {
    const cursor = { px: -195_000 / 1_000, py: -95 };
    const ctx = groupCtx({ members: [m1(), m2()], others: [neighbour()], cursor });
    selectTool.onPointerMove!(ctx);
    const guides = (ctx.setAlignGuides as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(guides).toHaveLength(2);
    expect(guides.map((g: { axis: string }) => g.axis).sort()).toEqual(['x', 'y']);

    cursor.px = 0; cursor.py = 0;
    selectTool.onPointerMove!(ctx);
    expect(ctx.setAlignGuides).toHaveBeenLastCalledWith([]);
  });
});

// ─── selectTool — 잠긴 도형의 다중 선택 ────────────────────────────────────
//
// 잠긴 것을 고를 수 있어야 **한꺼번에 풀 수 있다**. 선택은 지목이지 편집이 아니다.
describe('selectTool — 잠긴 도형도 고른다', () => {
  const locked = (id: string): Drawing => ({
    id, kind: 'hline', price: 100, color: '#14B8A6', width: 1.5,
    lineStyle: 'solid', paneId: 'candle', locked: true,
  });

  it('Shift+클릭은 잠긴 도형도 토글한다', () => {
    const target = locked('lk1');
    // makeCtx 의 파생 hitTestUnlockedAt 이 정확히 이 분기를 가른다: hitTestAt 은
    // 잠긴 것을 주고, hitTestUnlockedAt 은 null 을 준다. 옛 코드였다면 후자를
    // 읽어 마퀴가 시작됐을 것이다.
    const ctx = makeCtx({ shiftKey: true, hitTestAt: vi.fn(() => target) });
    selectTool.onPointerDown!(ctx);
    expect(ctx.toggleSelected).toHaveBeenCalledWith('lk1');
    expect(ctx.marqueeDraft.current).toBeNull();
  });

  // Shift 없는 경로는 그대로다 — 게이트가 잠긴 도형 위에서 'none' 이라 오버레이가
  // 클릭을 받지 못하고, window 리스너의 'select-locked' 가 단일 선택을 맡는다.
  // 따라서 그룹 드래그는 잠긴 멤버에서 **시작될 수 없다.** 그게 잠금의 뜻이다.
  it('맨 클릭은 잠긴 도형을 잡지 않는다 — 그룹 드래그가 거기서 시작되지 않는다', () => {
    const ctx = makeCtx({
      hitTestAt: vi.fn(() => locked('lk1')),
      selectedIds: ['lk1', 'h2'],
    });
    selectTool.onPointerDown!(ctx);
    expect(ctx.dragRef.current).toBeNull();
  });
});
