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
 * 반드시 일치해야 한다(불일치 시 게이트가 다른 창을 기다림) — `displayFloorDate` 도
 * 그 산식의 일부라 **같은 값**을 받아야 한다. 그 값의 유일 생산자는 `useLiveChartData`
 * 의 `dailyMaWindowFloorDate` 이고, 오버레이·최대벽 필터도 거기서 내려온 것을 쓴다.
 *
 * `candles.length === 0` 조건: 캐시 히트(재방문)로 이미 데이터가 있으면 즉시 열려 홀드
 * 없음. enabled=false(일봉MA off / D·W·M / code 없음)면 항상 false. 에러 settle 시
 * useResolvedDailyCandles.isLoading=false라 영구 홀드 없음. */
export function useDailyMaRevealGate(args: {
  code: string | null;
  timeframe: LiveTimeframe;
  venue: LiveVenueOption;
  todayKst: string;
  /** 창이 덮어야 할 표시 하한(계단으로 내린 값). 소비처 넷이 공유한다 — 위 도크스트링. */
  displayFloorDate?: string | null;
}): boolean {
  const configs = useWindowIndicator((s) => s.dailyMovingAverages);
  // 오버레이(`DailyMovingAverageOverlay`)의 fetch 게이트와 **같은 식**이어야 쿼리 키가
  // 하나로 모인다 — 마스터 토글이 슬롯으로 접힌 뒤로 그 자리는 "켜진 슬롯 존재" 다.
  const enabled = configs.some((c) => c.enabled)
    && isMinuteTimeframe(args.timeframe) && !!args.code && !!args.todayKst;
  const fetchWindow = enabled ? dailyMaFetchWindow(args.todayKst, configs, args.displayFloorDate) : null;
  const dailyQuery = useResolvedDailyCandles({
    code: args.code,
    from: fetchWindow?.from ?? null,
    to: fetchWindow?.to ?? null,
    venue: args.venue,
    enabled,
  });
  return enabled && dailyQuery.isLoading && dailyQuery.candles.length === 0;
}
