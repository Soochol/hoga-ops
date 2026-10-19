import type { InvestorNetUnit, InvestorTradeSide } from '../../api/types';
import { formatAmount, formatQty } from '../../sidebar/InvestorTrendEstimateCardHelpers';
import { formatInvestorK } from '../investorDailySummary';

/** Visible value without a unit suffix; formatting follows the response unit. */
export function formatInvestorDailyNumber(value: number | null, unit: InvestorNetUnit,
  side: InvestorTradeSide, useK: boolean): string {
  if (value === null) return '—';
  const text = unit === 'qty_shares'
    ? useK ? formatInvestorK(value, side === 'net').replace(/K$/, '') : formatQty(value)
    : formatAmount(unit === 'amt_eok' ? value * 100 : value).replace(/억$/, '');
  return side === 'net' ? text : text.replace(/^\+/, '');
}

/** Reserve the longest body/footer value before fixed table tracks are assigned. */
export function investorDailyTableLayout(values: string[], count: number, summary: boolean,
  amount: boolean, dateLabel: string) {
  let figures = 0;
  for (const text of values) {
    const integer = amount ? text.split('.')[0] : text;
    const commas = integer.match(/,/g)?.length ?? 0;
    figures = Math.max(figures, integer.length - commas / 2 + (amount ? 2 : 0));
  }
  const dateChars = Array.from(dateLabel).reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? 2 : 1), 0);
  const dateWidth = `max(5rem, calc(${dateChars}ch + 1rem))`;
  // Summary: three equal numeric tracks, two half-ch dots, four 4px gaps,
  // and 16px cell padding. The extra pixel protects the group border.
  const valueWidth = summary
    ? `calc(3 * max(4.5rem, ${figures}ch) + 2rem + 1ch + 1px)`
    : `max(6.5rem, calc(${figures}ch + 1.5rem + 1px))`;
  return { dateWidth, minWidth: `calc(${dateWidth} + ${count} * ${valueWidth})` };
}
