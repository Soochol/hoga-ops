import { describe, expect, it } from 'vitest';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { Coordinate, Time } from 'lightweight-charts';
import { CandleWidthVolume } from './CandleWidthVolume';
import source from '../../node_modules/lightweight-charts/dist/lightweight-charts.development.mjs?raw';

// Exercise the installed library's actual candle renderer, not a second copy of
// our width formula. A dependency upgrade that changes its geometry must fail.
function section(from: string, to: string): string {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error('lightweight-charts renderer changed; review width parity fixture');
  return source.slice(start, end);
}
const CandleRenderer = new Function(
  'class BitmapCoordinatesPaneRenderer {}\n' +
  section('function optimalCandlestickWidth(', 'class PaneRendererBars ') +
  section('class PaneRendererCandlesticks ', 'class SeriesCandlesticksPaneView ') +
  '\nreturn PaneRendererCandlesticks;',
)();
type Rect = { x: number; y: number; w: number; h: number; color: string };
function recorder(dpr: number) {
  const rects: Rect[] = [];
  const context = {
    fillStyle: '',
    fillRect(x: number, y: number, w: number, h: number) { rects.push({ x, y, w, h, color: this.fillStyle }); },
  };
  const scope = { context, horizontalPixelRatio: dpr, verticalPixelRatio: dpr };
  const target = { useBitmapCoordinateSpace: (draw: (s: typeof scope) => void) => draw(scope) } as unknown as CanvasRenderingTarget2D;
  return { rects, scope, target };
}
const priceConverter = (p: number) => (100 - p) as Coordinate;

describe('volume body matches the installed candlestick renderer', () => {
  it.each([1, 1.25, 1.5, 2, 3])('matches left edge and width across zoom levels at DPR %s', (dpr) => {
    for (const barSpacing of [0.5, 1, 2, 2.49, 2.5, 3, 4, 4.01, 6, 7.5, 8, 12, 20, 50]) {
      const bars = Array.from({ length: 5 }, (_, i) => ({
        x: 100.3 + i * barSpacing, time: i,
        originalData: { time: i as Time, value: 30, color: 'red' }, barColor: 'blue',
      }));
      const reference = new CandleRenderer();
      reference._internal_setData({
        _internal_bars: bars.map(b => ({ _internal_x: b.x, _internal_openY: 70, _internal_closeY: 100, _internal_barColor: 'red' })),
        _internal_barSpacing: barSpacing, _internal_borderVisible: false,
        _internal_wickVisible: false, _internal_visibleRange: { from: 1, to: 4 },
      });
      const expected = recorder(dpr);
      reference._internal__drawImpl(expected.scope);
      const volume = new CandleWidthVolume();
      volume.update({ bars, barSpacing, conflationFactor: 1, visibleRange: { from: 1, to: 4 } });
      const actual = recorder(dpr);
      volume.renderer().draw(actual.target, priceConverter, false);
      expect(actual.rects.map(({x, w}) => ({x, w})), `barSpacing=${barSpacing}`).toEqual(expected.rects.map(({x, w}) => ({x, w})));
    }
  });

  it('keeps zero baseline, per-row colors, values and whitespace semantics', () => {
    const volume = new CandleWidthVolume();
    expect(volume.priceValueBuilder({ time: 1 as Time, value: 30 })).toEqual([0, 30, 30]);
    expect(volume.isWhitespace({ time: 1 as Time })).toBe(true);
    expect(volume.isWhitespace({ time: 1 as Time, value: 0 })).toBe(false);
    volume.update({ bars: [{ x: 20, time: 0, originalData: { time: 1 as Time, value: 30, color: 'red' }, barColor: 'blue' }], barSpacing: 8, conflationFactor: 1, visibleRange: { from: 0, to: 1 } });
    const actual = recorder(1);
    volume.renderer().draw(actual.target, priceConverter, false);
    expect(actual.rects).toEqual([{ x: 18, y: 70, w: 5, h: 31, color: 'red' }]);
    volume.update({ bars: [], barSpacing: 8, conflationFactor: 1, visibleRange: null });
    volume.renderer().draw(actual.target, priceConverter, false);
    expect(actual.rects).toHaveLength(1);
  });
});
