import { CHART_TIMESCALE_OPTIONS } from '../util/chartScale';

export const MINUTE_RIGHT_LABEL_GUTTER_PX = 180;

export function minuteRightOffsetBars(visibleBars: number, plotWidth: number): number {
  const configured = CHART_TIMESCALE_OPTIONS.rightOffset ?? 0;
  if (plotWidth <= MINUTE_RIGHT_LABEL_GUTTER_PX || visibleBars <= 0) return configured;
  const offsetForLabelGutter = Math.ceil(
    (MINUTE_RIGHT_LABEL_GUTTER_PX * visibleBars) /
      (plotWidth - MINUTE_RIGHT_LABEL_GUTTER_PX),
  );
  return Math.max(configured, offsetForLabelGutter);
}
