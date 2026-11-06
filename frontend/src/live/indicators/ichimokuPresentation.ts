import type { IndicatorSettings } from '../../state/indicatorSettingsV2';
import { lineVisible } from '../../state/indicatorLineVisibility';
import type { IchimokuStyle } from '../../chart/IchimokuPrimitive';
import type { IchimokuPeriods } from '../../chart/projectors/ichimoku';
export const ICHIMOKU_PRESENTATION = {
  conversion: { label: '전환선', color: 'ichimokuConversionColor', line: 'ichimokuConversion' },
  base: { label: '기준선', color: 'ichimokuBaseColor', line: 'ichimokuBase' },
  leadingA: { label: '선행 A', color: 'ichimokuLeadingAColor', line: 'ichimokuLeadingA' },
  leadingB: { label: '선행 B', color: 'ichimokuLeadingBColor', line: 'ichimokuLeadingB' },
  lagging: { label: '후행선', color: 'ichimokuLaggingColor', line: 'ichimokuLagging' },
} as const;
export function ichimokuPeriods(s: IndicatorSettings): IchimokuPeriods {
  return { conversion: s.ichimokuConversionPeriod, base: s.ichimokuBasePeriod, leadingB: s.ichimokuLeadingBPeriod, displacement: s.ichimokuDisplacement };
}
export function ichimokuStyle(s: IndicatorSettings): IchimokuStyle {
  const line = (key: keyof typeof ICHIMOKU_PRESENTATION) => ({ visible: lineVisible(s.indicatorLineVisibility, ICHIMOKU_PRESENTATION[key].line), color: s[ICHIMOKU_PRESENTATION[key].color] });
  return { lines: { conversion: line('conversion'), base: line('base'), leadingA: line('leadingA'), leadingB: line('leadingB'), lagging: line('lagging') }, lineWidth: s.ichimokuLineWidth,
    cloud: { visible: s.ichimokuCloudVisible, positiveColor: s.ichimokuCloudPositiveColor, negativeColor: s.ichimokuCloudNegativeColor, opacity: s.ichimokuCloudOpacity } };
}
