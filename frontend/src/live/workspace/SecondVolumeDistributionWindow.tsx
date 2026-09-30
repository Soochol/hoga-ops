import { useLiveCursorStore } from '../useLiveCursorStore';
import { useMemo } from 'react';
import { useSecondAggregates } from '../../api/secondAggregates';
import { useLiveVenueStore } from '../../state/liveVenue';
import type { WorkspaceWindow } from '../../state/workspace';
import { VolumeDistributionCard } from '../../sidebar/VolumeDistributionCard';
import { secondPriceDistribution } from './secondAggregateProjectors';
import { todayKstYyyymmdd } from '../liveDateTime';
import { useEffectiveVenue } from '../useEffectiveVenue';
import type { GroupChartLinkVdistSettings } from './groupChartLinkSource';


export function SecondVolumeDistributionWindow({ win, code, settings }: { win: WorkspaceWindow; code: string; settings: GroupChartLinkVdistSettings }) {
  const selected = useLiveVenueStore(s => s.venue);
  const venue = useEffectiveVenue(code, selected);
  const date = todayKstYyyymmdd();
  const query = useSecondAggregates(code, venue, date, null, true);
  const cursor = useLiveCursorStore(s => s.sidebarCursorOrigin?.group === win.group && s.sidebarCursorOrigin?.code === code
    && s.sidebarCursorOrigin?.timeframe === '10s' ? s.sidebarCursorMs : null);
  const profile = useMemo(() => secondPriceDistribution((query.data?.prices ?? []).filter(p => !settings.hoverCutoffEnabled || cursor === null || p.t_ms < cursor + 10_000), date, settings.rangeCount), [query.data, date, settings.rangeCount, settings.hoverCutoffEnabled, cursor]);
  return <div className="h-full flex flex-col bg-bg-card">
    <div className="min-h-0 flex-1 overflow-auto"><VolumeDistributionCard profile={profile} cursorMs={cursor} closePoints={query.data?.bars.map(bar => ({ t_ms: bar.t_ms, close: bar.close }))}
      color={settings.color} maxColor={settings.maxColor} /></div>
    <div className="text-fg-dim text-xs px-2 py-1" role="status">{query.isError ? '매물대를 불러오지 못했습니다' : '수집된 체결 기준'}</div>
  </div>;
}
