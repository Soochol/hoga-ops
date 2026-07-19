import { isMinuteTimeframe, type LiveTimeframe } from '../../state/livePage';
import type { LiveVenueOption } from '../../state/liveVenue';
import { dailyMaFetchWindow } from './dailyMaProjection';
import { useResolvedDailyCandles } from './useResolvedDailyCandles';
import { useWindowIndicator } from '../workspace/windowView';

/** 일봉 MA 오버레이의 초기 fetch가 pending인지 LiveChartRoot의 reveal 게이트에서 쓸 수
 * 있게 노출한다(개선안 1-B). DailyMovingAverageOverlay가 오버레이 내부에서 fetch하므로
 * 게이트 신호가 위로 안 올라오는 문제를, 오버레이와 **동일한 enabled/window/쿼리키**를
 * LivePage에서 한 번 더 호출해 해결한다 — react-query가 키로 dedup하므로 네트워크 중복은
 * 없고 캐시만 공유한다. enable/window 산식은 오버레이(DailyMovingAverageOverlay:50-61)와
 * 반드시 일치해야 한다(불일치 시 게이트가 다른 창을 기다림).
 *
 * `candles.length === 0` 조건: 캐시 히트(재방문)로 이미 데이터가 있으면 즉시 열려 홀드
 * 없음. enabled=false(일봉MA off / D·W·M / code 없음)면 항상 false. 에러 settle 시
 * useResolvedDailyCandles.isLoading=false라 영구 홀드 없음. */
export function useDailyMaRevealGate(args: {
  code: string | null;
  timeframe: LiveTimeframe;
  venue: LiveVenueOption;
  todayKst: string;
}): boolean {
  const masterEnabled = useWindowIndicator((s) => s.dailyMovingAverageEnabled);
  const configs = useWindowIndicator((s) => s.dailyMovingAverages);
  const enabled = masterEnabled && isMinuteTimeframe(args.timeframe) && !!args.code && !!args.todayKst;
  const fetchWindow = enabled ? dailyMaFetchWindow(args.todayKst, configs) : null;
  const dailyQuery = useResolvedDailyCandles({
    code: args.code,
    from: fetchWindow?.from ?? null,
    to: fetchWindow?.to ?? null,
    venue: args.venue,
    enabled,
  });
  return enabled && dailyQuery.isLoading && dailyQuery.candles.length === 0;
}
