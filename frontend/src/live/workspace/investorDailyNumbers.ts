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
