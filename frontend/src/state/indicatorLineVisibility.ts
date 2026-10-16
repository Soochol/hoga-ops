/** Missing entries are visible, preserving existing saved indicator settings. */
export const INDICATOR_LINE_KEYS = [
  'bollingerUpper', 'bollingerMiddle', 'bollingerLower',
  'supertrendUp', 'supertrendDown',
  'quoteTotalsBid', 'quoteTotalsAsk',
  'quoteTotalsBidLevel', 'quoteTotalsAskLevel',
  'quoteTotalsDayMaxBid', 'quoteTotalsDayMaxAsk',
  'fillStrengthBuy', 'fillStrengthSell',
] as const;
export type IndicatorLineKey = typeof INDICATOR_LINE_KEYS[number];
export type IndicatorLineVisibility = Partial<Record<IndicatorLineKey, boolean>>;
export const lineVisible = (visibility: IndicatorLineVisibility | undefined, key: IndicatorLineKey): boolean =>
  visibility?.[key] !== false;

export function normalizeLineVisibility(raw: unknown): IndicatorLineVisibility {
  if (!raw || typeof raw !== 'object') return {};
  const obj = raw as Record<string, unknown>;
  return Object.fromEntries(INDICATOR_LINE_KEYS.filter(key => obj[key] === false).map(key => [key, false]));
}
