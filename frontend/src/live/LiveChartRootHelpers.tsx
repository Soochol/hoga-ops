import { type LiveTimeframe, isMinuteTimeframe } from '../state/livePage';


export function shouldShowTradeVolumePocOverlay(
  timeframe: LiveTimeframe,
  forceHogaPanes: boolean,
  tradeVolumePocCount: number,
): boolean {
  return isMinuteTimeframe(timeframe) || (forceHogaPanes && tradeVolumePocCount > 0);
}


export function shouldShowDepthHeatmapOverlay(
  timeframe: LiveTimeframe,
  enabled: boolean,
  pointCount: number,
): boolean {
  return isMinuteTimeframe(timeframe) && enabled && pointCount > 0;
}
