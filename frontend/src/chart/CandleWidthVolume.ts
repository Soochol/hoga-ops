import {
  customSeriesDefaultOptions,
  type CustomSeriesOptions,
  type CustomSeriesWhitespaceData,
  type HistogramData,
  type ICustomSeriesPaneRenderer,
  type ICustomSeriesPaneView,
  type PaneRendererCustomData,
  type PriceToCoordinateConverter,
  type Time,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';

/** Matches lightweight-charts 5.2's optimalCandlestickWidth + wick parity.
 * Keep the renderer parity test when upgrading lightweight-charts.
 * Algorithm from TradingView/lightweight-charts (Apache-2.0).
 */
function candleBodyWidth(barSpacing: number, pixelRatio: number): number {
  let width: number;
  if (barSpacing >= 2.5 && barSpacing <= 4) {
    width = Math.floor(3 * pixelRatio);
  } else {
    const coefficient = 1 - 0.2 * Math.atan(Math.max(4, barSpacing) - 4) / (Math.PI * 0.5);
    width = Math.max(Math.floor(pixelRatio), Math.min(
      Math.floor(barSpacing * coefficient * pixelRatio),
      Math.floor(barSpacing * pixelRatio),
    ));
  }
  if (width >= 2 && width % 2 !== Math.floor(pixelRatio) % 2) width--;
  return width;
}

type VolumeData = HistogramData<Time>;

class VolumeRenderer implements ICustomSeriesPaneRenderer {
  data: PaneRendererCustomData<Time, VolumeData> | null = null;

  draw(target: CanvasRenderingTarget2D, priceConverter: PriceToCoordinateConverter): void {
    const data = this.data;
    if (!data?.visibleRange) return;
    const visibleRange = data.visibleRange;
    const base = priceConverter(0);
    if (base === null) return;
    target.useBitmapCoordinateSpace(({ context, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      const width = candleBodyWidth(data.barSpacing * data.conflationFactor, hr);
      const tickWidth = Math.max(1, Math.floor(vr));
      const baseTop = Math.round(base * vr) - Math.floor(tickWidth / 2);
      for (let i = visibleRange.from; i < visibleRange.to; i++) {
        const bar = data.bars[i];
        const coordinate = priceConverter(bar.originalData.value);
        if (coordinate === null) continue;
        const y = Math.round(coordinate * vr);
        const top = Math.min(y, baseTop);
        const bottom = y <= baseTop ? baseTop + tickWidth : y - Math.floor(tickWidth / 2) + tickWidth;
        context.fillStyle = bar.originalData.color ?? bar.barColor;
        context.fillRect(Math.round(bar.x * hr) - Math.floor(width / 2), top, width, bottom - top);
      }
    });
  }
}

/** Volume values and zero baseline retain histogram semantics; only body width changes. */
export class CandleWidthVolume implements ICustomSeriesPaneView<Time, VolumeData> {
  private readonly view = new VolumeRenderer();

  renderer(): ICustomSeriesPaneRenderer { return this.view; }

  update(data: PaneRendererCustomData<Time, VolumeData>): void { this.view.data = data; }

  priceValueBuilder(data: VolumeData): number[] { return [0, data.value, data.value]; }

  isWhitespace(data: VolumeData | CustomSeriesWhitespaceData<Time>): data is CustomSeriesWhitespaceData<Time> {
    return !('value' in data);
  }

  defaultOptions(): CustomSeriesOptions { return { ...customSeriesDefaultOptions }; }
}
