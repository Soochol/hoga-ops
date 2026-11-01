import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fitRegression } from './regression';
import { projectAnalysis, analysisHandlePatch } from './analysisGeometry';
import { advancedTool, pathTool, finishPath } from './advancedTools';
import { hitTestDrawings, drawingsInRect } from './hitTest';
import { normalizeItems, saveDrawings, loadDrawings } from './persistence';
import { cloneWithOffset } from './duplicate';
import { pricesOf, translateDrawing } from './translate';
import { coordinatePatch, drawingCoordinates } from '../DrawingDetails';
import { useDrawingsStore } from '../../state/drawings';
import { INITIAL_STYLE, FIB_EXTENSION_LEVELS, type AdvancedDrawing, type Regression } from './types';
import type { ToolCtx } from './tools';

const base = { id: 'advanced', color: '#14B8A6', width: 2, lineStyle: 'solid' as const, paneId: 'candle' as const };
const a = { realMs: 100, price: 10 }, b = { realMs: 200, price: 20 }, c = { realMs: 150, price: 15 };
const candles = [10, 13, 12, 17, 18].map((close, i) => ({ ts_ms: 100 + i * 25, close, open: close + 2, high: close + 4, low: close - 2 }));
const regression: Regression = { ...base, kind: 'regression', a, b, source: 'close', upperDeviation: 2, lowerDeviation: 2, fillOpacity: 0.1 };
const variants: AdvancedDrawing[] = [
  { ...base, kind: 'fib-extension', a, b, c, levels: [...FIB_EXTENSION_LEVELS], extendRight: true },
  { ...base, kind: 'path', points: [a, c, b], arrowStart: false, arrowEnd: true },
  { ...base, kind: 'callout', a, offsetX: 50, offsetY: 30, text: '매수 근거\n구간 확인', fontSize: 13 },
  regression,
];
const coords = { x: (ms: number) => ms, y: (p: number) => p * 10, width: 500, candles, measureTextWidth: (s: string) => s.length * 8 };
const hitCoords = { realMsToCanvasX: coords.x, priceToCanvasY: coords.y, paneIdAtY: () => 'candle' as const, plotWidth: 500, candles, measureTextWidth: coords.measureTextWidth };

describe('regression mathematics and data availability', () => {
  it('fits OLS on bar ordinals with population residual sigma', () => {
    const fit = fitRegression(regression, candles)!;
    expect(fit.first.price).toBeCloseTo(10);
    expect(fit.last.price).toBeCloseTo(18);
    expect(fit.deviation).toBeCloseTo(Math.sqrt(1.2));
    expect(fit.count).toBe(5);
    expect(fitRegression({ ...regression, a: b, b: a }, candles)).toEqual(fit);
  });
  it.each([['open', 2], ['high', 4], ['low', -2], ['hl2', 1], ['hlc3', 2 / 3], ['ohlc4', 1]] as const)('uses %s prices', (source, delta) => {
    expect(fitRegression({ ...regression, source }, candles)!.first.price).toBeCloseTo(10 + delta);
  });
  it('rejects missing endpoints, one bar and invalid prices without filtering holes', () => {
    expect(fitRegression(regression, candles.slice(1))).toBeNull();
    expect(fitRegression({ ...regression, b: a }, candles)).toBeNull();
    expect(fitRegression(regression, candles.map((p, i) => i === 2 ? { ...p, close: NaN } : p))).toBeNull();
    expect(fitRegression(regression)).toBeNull();
  });
  it('recomputes for new candle arrays and remains stable for large prices', () => {
    const next = candles.map(p => ({ ...p, close: p.close + 1e10 }));
    expect(fitRegression(regression, next)!.deviation).toBeCloseTo(Math.sqrt(1.2), 5);
    expect(fitRegression(regression, next)!.last.price).toBeCloseTo(1e10 + 18);
    expect(fitRegression(regression, candles)!.last.price).toBeCloseTo(18);
  });
});

describe('advanced drawing geometry and editing', () => {
  it('projects extension levels from the third anchor in either direction', () => {
    const d = variants[0];
    expect(projectAnalysis(d, coords).segments[4].a.y).toBe(250); // 1.0 = C + (B-A)
    expect(projectAnalysis({ ...d, a: b, b: a } as typeof d, coords).segments[4].a.y).toBe(50);
    expect(analysisHandlePatch(d, 'c', { realMs: 170, price: 11 })).toEqual({ c: { realMs: 170, price: 11 } });
  });
  it('shares callout multiline box geometry with hit testing and marquee', () => {
    const d = variants[2], g = projectAnalysis(d, coords), box = g.annotations![0].box;
    expect(box.height).toBeGreaterThan(38);
    expect(hitTestDrawings(hitCoords, [d], box.x + 20, box.y + 12)).toBe(d);
    expect(drawingsInRect(hitCoords, [d], { x1: box.x + 10, x2: box.x + 20, y1: box.y + 10, y2: box.y + 20 })).toEqual([d]);
    expect(analysisHandlePatch(d, 'a', b)).toEqual({ a: b });
    expect(analysisHandlePatch(d, 'box', b)).toBeNull();
  });
  it('edits path vertices independently and projects end arrows', () => {
    const d = variants[1];
    expect(projectAnalysis(d, coords).segments.at(-1)?.arrowEnd).toBe(true);
    expect(analysisHandlePatch(d, 1, b)).toMatchObject({ points: [a, b, b] });
    expect(analysisHandlePatch(d, 9, b)).toBeNull();
  });
  it('regression uses fitted handles and ignores vertical translations', () => {
    expect(projectAnalysis(regression, coords).handles.at(-1)?.at.y).toBeCloseTo(180);
    expect(analysisHandlePatch(regression, 'b', { realMs: 175, price: -999 }, candles)).toEqual({ b: { ...b, realMs: 175 } });
    expect(analysisHandlePatch(regression, 'b', { realMs: 999, price: 1 }, candles)).toBeNull();
    expect(pricesOf(regression)).toEqual([]);
    expect(translateDrawing(regression, 0, 999)).toEqual({ a, b });
    expect(projectAnalysis(regression, { ...coords, candles: [] }).segments).toEqual([]);
  });
  it('edits KST path coordinates and regression time without overwriting stored prices', () => {
    for (const d of variants) {
      const values = Object.fromEntries(drawingCoordinates(d).flatMap(p => [
        ...(p.realMs == null ? [] : [[`${p.key}.realMs`, p.key === 'b' ? '2026-11-01T09:01:00' : '2026-11-01T09:00:00']]),
        ...(p.price == null ? [] : [[`${p.key}.price`, String(p.price)]]),
      ]));
      expect(coordinatePatch(d, values)).not.toBeNull();
      if (d.kind === 'regression') expect(coordinatePatch(d, values)).toMatchObject({ a: { price: 10 }, b: { price: 20 } });
      if (d.kind === 'path') expect(coordinatePatch(d, { ...values, 'point:1.price': '12.125' })).toMatchObject({ points: [expect.anything(), { price: 12.125 }, expect.anything()] });
    }
  });
});

describe('advanced lifecycle and gestures', () => {
  beforeEach(() => { localStorage.clear(); useDrawingsStore.getState().__resetForTests(); });
  it.each(variants)('$kind round trips and supports clone, undo, hide and lock', d => {
    saveDrawings('advanced|minute', [d]);
    expect(loadDrawings('advanced|minute')).toEqual([d]);
    const clone = cloneWithOffset(d, 25, 1);
    expect(clone.id).not.toBe(d.id);
    if (d.kind === 'path' && clone.kind === 'path') expect(clone.points).not.toBe(d.points);
    const s = useDrawingsStore.getState(); s.add('test', d); s.update('test', d.id, { hidden: true }); s.undo('test');
    expect(useDrawingsStore.getState().drawingsFor('test')[0].hidden).not.toBe(true);
    s.update('test', d.id, { locked: true }); s.update('test', d.id, { color: '#FFFFFF' });
    expect(useDrawingsStore.getState().drawingsFor('test')[0].color).toBe(d.color);
  });
  it('normalizes imported bounds and rejects malformed new shapes', () => {
    expect(normalizeItems([{ ...variants[1], points: [a] }, { ...variants[2], text: '' }, { ...regression, paneId: 'ratio' }])).toEqual([]);
    expect(normalizeItems([{ ...regression, source: 'bad', upperDeviation: -4, lowerDeviation: Infinity }])[0]).toMatchObject({ source: 'close', upperDeviation: 0, lowerDeviation: 2 });
  });
  function context() {
    return { px: 100, py: 10, pointerId: 1, advancedDraft: { current: null }, defaults: INITIAL_STYLE, candles,
      paneIdAtY: () => 'candle', pixelToData: (x: number, y: number) => ({ realMs: x, price: y }),
      capturePointer: vi.fn(), releasePointer: vi.fn(), requestRedraw: vi.fn(), add: vi.fn(), beginCalloutEdit: vi.fn() } as unknown as ToolCtx;
  }
  it('finishes clicked path vertices on Enter without saving hover', () => {
    const ctx = context(); pathTool.onPointerDown!(ctx); ctx.px = 150; pathTool.onPointerDown!(ctx);
    ctx.px = 200; pathTool.onPointerMove!(ctx); expect(finishPath(ctx)).toBe(true);
    expect(ctx.add).toHaveBeenCalledWith(expect.objectContaining({ points: [{ realMs: 100, price: 10 }, { realMs: 150, price: 10 }] }));
  });
  it('double click removes the duplicate terminal click', () => {
    const ctx = context(); pathTool.onPointerDown!(ctx); ctx.px = 150; pathTool.onPointerDown!(ctx); pathTool.onPointerDown!(ctx);
    expect(finishPath(ctx, true)).toBe(true); expect(ctx.add).toHaveBeenCalledWith(expect.objectContaining({ points: [a, { realMs: 150, price: 10 }] }));
  });
  it('keeps all 128 vertices when a terminal double click reaches the limit', () => {
    const ctx = context();
    for (let i=0; i<129; i++) { ctx.px=100+i; pathTool.onPointerDown!(ctx); }
    expect(finishPath(ctx,true)).toBe(true);
    expect(vi.mocked(ctx.add).mock.calls[0][0]).toMatchObject({points:expect.arrayContaining([{realMs:227,price:10}])});
    expect((vi.mocked(ctx.add).mock.calls[0][0] as Extract<AdvancedDrawing,{kind:'path'}>).points).toHaveLength(128);
  });
  it('extension waits for third anchor and commits exactly once', () => {
    const ctx = context(), tool = advancedTool('fib-extension', '확장'); tool.onPointerDown!(ctx); ctx.px = 200; ctx.py = 20; tool.onPointerUp!(ctx);
    expect(ctx.add).not.toHaveBeenCalled(); ctx.px = 150; ctx.py = 15; tool.onPointerDown!(ctx); tool.onPointerUp!(ctx);
    expect(ctx.add).toHaveBeenCalledTimes(1); expect(ctx.add).toHaveBeenCalledWith(expect.objectContaining({ c }));
  });
  it('callout opens the text editor after positioning, without adding placeholder text', () => {
    const ctx = context(), tool = advancedTool('callout', '콜아웃'); tool.onPointerDown!(ctx); tool.onPointerUp!(ctx);
    expect(ctx.add).not.toHaveBeenCalled(); expect(ctx.beginCalloutEdit).toHaveBeenCalledWith(a, 'candle', 80, -50);
  });
  it('regression rejects unavailable endpoints and accepts loaded ranges', () => {
    const ctx = context(), tool = advancedTool('regression', '회귀'); tool.onPointerDown!(ctx); ctx.px = 999; tool.onPointerUp!(ctx);
    expect(ctx.add).not.toHaveBeenCalled(); ctx.px = 100; tool.onPointerDown!(ctx); ctx.px = 200; tool.onPointerUp!(ctx);
    expect(ctx.add).toHaveBeenCalledOnce();
  });
});
