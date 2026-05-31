import {
  HistogramSeries,
  type HistogramData,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { RangeBundle } from '../../api/types';
import { type VirtualAxis } from '../../util/virtualAxis';
import { useShallow } from 'zustand/react/shallow';
import { resolveTokens } from '../../util/tokens';
import { formatKoreanInt } from '../../util/koreanNumber';
import { useLivePageStore } from '../../state/livePage';
import type { PaneSpec } from '../RangeSeriesPane';

const TOKEN_SPEC = {
  up: ['--price-up', '#DC2626'],
  down: ['--price-down', '#2563EB'],
} as const;

const { up, down } = resolveTokens(TOKEN_SPEC);

const priceFormat = {
  type: 'custom' as const,
  formatter: (v: number) => formatKoreanInt(v),
  minMove: 1,
};

export function projectVolume(bundle: RangeBundle, axis: VirtualAxis): HistogramData<Time>[] {
  return bundle.candles
    .filter((c) => axis.contains(c.ts_ms))
    .map((c): HistogramData<Time> => ({
      time: (axis.toVirtual(c.ts_ms) / 1000) as UTCTimestamp,
      value: c.vol_a + c.vol_b,
      color: c.close >= c.open ? up : down,
    }));
}

export type VolumePaneContext = { volumeEnabled: boolean };

const useVolumeContext = (): VolumePaneContext =>
  useLivePageStore(useShallow((s) => ({ volumeEnabled: s.volumeEnabled })));

export const VOLUME_SPEC = {
  name: 'volume' as const,
  stretch: 0.3,
  useContext: useVolumeContext,
  series: [
    {
      type: HistogramSeries,
      options: {
        priceFormat,
        priceScaleId: 'right',
        priceLineVisible: false,
        lastValueVisible: false,
      },
      // volumeEnabled=false → empty data (bars hidden, pane stays mounted so
      // drawing pane-index stays stable). FillStrength useContext precedent.
      data: (bundle: RangeBundle, axis: VirtualAxis, ctx: VolumePaneContext) =>
        ctx.volumeEnabled ? projectVolume(bundle, axis) : [],
    },
  ],
} satisfies PaneSpec<VolumePaneContext>;
