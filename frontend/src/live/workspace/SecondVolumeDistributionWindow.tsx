import { bucketSeconds, type SecondTimeframe } from '../../state/livePage';
import { useLiveCursorStore } from '../useLiveCursorStore';
import { useMemo } from 'react';
import { useSecondAggregates } from '../../api/secondAggregates';
import { useLiveVenueStore } from '../../state/liveVenue';
import type { WorkspaceWindow } from '../../state/workspace';
import { VolumeDistributionCard } from '../../sidebar/VolumeDistributionCard';
import { secondPriceDistribution } from './secondAggregateProjectors';
import { realMsToYyyymmdd } from '../liveDateTime';
import { useEffectiveVenue } from '../useEffectiveVenue';
import type { GroupChartLinkVdistSettings } from './groupChartLinkSource';
import { buildSecondPriceDistributionIndex } from './secondPriceDistributionIndex';
import type { SecondPrice } from '../../api/secondAggregates';

const EMPTY_PRICES: readonly SecondPrice[] = [];

export function SecondVolumeDistributionWindow({ win, code, settings, timeframe, date }: { win: WorkspaceWindow; code: string; settings: GroupChartLinkVdistSettings; timeframe: SecondTimeframe; date: string }) {
  const selected = useLiveVenueStore(s => s.venue);
  const venue = useEffectiveVenue(code, selected);
  const seconds = bucketSeconds(timeframe) as 1 | 5 | 10 | 30;
  const cursor = useLiveCursorStore(s => s.sidebarCursorOrigin?.group === win.group && s.sidebarCursorOrigin?.code === code
    && s.sidebarCursorOrigin?.timeframe === timeframe ? s.sidebarCursorMs : null);
  const effectiveDate = cursor !== null ? realMsToYyyymmdd(cursor) : date;
  const query = useSecondAggregates(code, venue, effectiveDate, null, true, seconds, settings.regularSessionOnly ?? false);
  const prices = query.data?.prices ?? EMPTY_PRICES;
  const index = useMemo(() => settings.hoverCutoffEnabled
    ? buildSecondPriceDistributionIndex(prices, effectiveDate, settings.rangeCount) : null,
  [prices, effectiveDate, settings.rangeCount, settings.hoverCutoffEnabled]);
  const finalProfile = useMemo(() => index ? index.profileAt() : secondPriceDistribution(prices, effectiveDate, settings.rangeCount),
    [index, prices, effectiveDate, settings.rangeCount]);
  const cutoff = settings.hoverCutoffEnabled && cursor !== null ? cursor + seconds * 1000 : null;
  const profile = useMemo(() => cutoff !== null && index ? index.profileAt(cutoff) : finalProfile,
    [cutoff, index, finalProfile]);
  const closePoints = useMemo(() => query.data?.bars.map(bar => ({ t_ms: bar.t_ms, close: bar.close })), [query.data?.bars]);
  return <div className="h-full flex flex-col bg-bg-card">
    <div className="min-h-0 flex-1 overflow-auto"><VolumeDistributionCard profile={profile} cursorMs={cursor} closePoints={closePoints}
      color={settings.color} maxColor={settings.maxColor} /></div>
    <div className="text-fg-dim text-xs px-2 py-1" role="status">{query.isError ? '매물대를 불러오지 못했습니다' : query.data?.source === 'hogaplay' ? '과거 체결 원본 기준' : '수집된 체결 기준'}</div>
  </div>;
}
