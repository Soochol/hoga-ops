import { useMemo } from 'react';
import { useLivePastCandles } from '../../api/livePastCandles';
import { useLiveSeries } from '../../api/liveSeries';
import { isWarningFailure } from '../../api/dataWarnings';
import { useLiveVenueStore } from '../../state/liveVenue';
import { useEffectiveVenue } from '../useEffectiveVenue';
import { realMsToYyyymmdd } from '../liveDateTime';
import { buildStockClosePoints } from './majorIndicesStockModel';

export function useMajorIndicesStock(code: string | null, date: string) {
  const selectedVenue = useLiveVenueStore(state => state.venue);
  const venue = useEffectiveVenue(code, selectedVenue);
  const now = Date.now(), today = realMsToYyyymmdd(now);
  const history = useLivePastCandles(code, code ? date : null, code ? date : null, venue, today);
  const live = useLiveSeries(code && date === today ? code : '', venue);
  const points = useMemo(() => code ? buildStockClosePoints(date, now, history.data?.candles ?? [], live.trade) : [],
    [code, date, now, history.data?.candles, live.trade]);
  return { points, loading: !!code && history.isPending,
    failed: !!code && (history.isError || !!history.data?.data_warnings.some(isWarningFailure)) };
}
