import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { HistogramSeries, type IChartApi, type ISeriesApi, type SeriesType } from 'lightweight-charts';
import RangeSeriesPane, { type PaneSpec, type SeriesLegendMeta } from '../../chart/RangeSeriesPane';
import { projectVolumeCached } from '../../chart/projectors/volume';
import type { RangeBundle } from '../../api/types';
import type { VirtualAxis } from '../../util/virtualAxis';
import { useActivePrefs } from '../../state/chartPrefs';
import type { VolumeOverlayStyle } from '../../state/chartDisplayPrefs';
import { formatKoreanK } from '../../util/koreanNumber';
import { useWindowIndicator } from '../workspace/windowView';
import type { VolumeColorMode } from '../../state/liveIndicatorsPersistence';

type Context = VolumeOverlayStyle & { swapColors: boolean; colorMode: VolumeColorMode };
const SPEC = {
  name: 'candle-volume', stretch: 0,
  series: [{
    type: HistogramSeries,
    options: {
      priceScaleId: 'candle-volume', priceLineVisible: false, lastValueVisible: false,
      priceFormat: { type: 'custom', formatter: formatKoreanK, minMove: 1 },
    },
    legend: { label: '거래량' },
    data: (bundle: RangeBundle, axis: VirtualAxis, ctx: Context) => projectVolumeCached(bundle, axis, ctx.swapColors, ctx, ctx.colorMode),
    afterAdd: (series) => series.setSeriesOrder(0),
  }],
} satisfies PaneSpec<Context>;

type Props = {
  chart: IChartApi; bundle: RangeBundle; axis: VirtualAxis;
  onLegendReady: (name: string, entries: { series: ISeriesApi<SeriesType>; meta: SeriesLegendMeta }[]) => void;
  onLegendGone: (name: string) => void;
};

/** Shares time/pane with candles, but never their price scale or drawing handle. */
function VolumeOverlay({ chart, bundle, axis, onLegendReady, onLegendGone }: Props) {
  const transparency = useActivePrefs(p => p.volumeOverlayTransparency);
  const height = useActivePrefs(p => p.volumeOverlayHeight);
  const up = useActivePrefs(p => p.volumeOverlayUpColor);
  const down = useActivePrefs(p => p.volumeOverlayDownColor);
  const swapColors = useActivePrefs(p => p.candleInvertScale && p.candleInvertColors);
  const colorMode = useWindowIndicator(s => s.volumeColorMode);
  const ctx = useMemo<Context>(() => ({ volumeOverlayTransparency: transparency, volumeOverlayHeight: height,
    volumeOverlayUpColor: up, volumeOverlayDownColor: down, swapColors, colorMode }), [transparency, height, up, down, swapColors, colorMode]);
  const series = useRef<ISeriesApi<SeriesType> | null>(null);
  const ready = useCallback((s: ISeriesApi<SeriesType>) => { series.current = s; }, []);
  const gone = useCallback(() => { series.current = null; }, []);
  // Candle spec has no legend series. Register under the physical candle pane
  // without creating a volume drawing handle or changing its persisted pane id.
  const legendReady = useCallback((_: string, entries: Parameters<Props['onLegendReady']>[1]) => onLegendReady('candle', entries), [onLegendReady]);
  const legendGone = useCallback(() => onLegendGone('candle'), [onLegendGone]);
  useEffect(() => {
    series.current?.priceScale().applyOptions({
      autoScale: true, mode: 0, invertScale: false,
      scaleMargins: { top: 1 - height / 100, bottom: 0 },
    });
  }, [chart, height]);
  return <RangeSeriesPane chart={chart} bundle={bundle} axis={axis} paneIndex={0} precedingPaneKey=""
    spec={SPEC} contextOverride={ctx} onPrimarySeriesReady={ready} onPrimarySeriesGone={gone}
    onLegendReady={legendReady} onLegendGone={legendGone} />;
}
export default memo(VolumeOverlay);
