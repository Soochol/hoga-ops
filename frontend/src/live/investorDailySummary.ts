import type { LivePastInvestorNetResponse } from '../api/livePastInvestorNet';
import type { InvestorNetUnit, InvestorTradeSide } from '../api/types';
import { buildInvestorDailyTable, type InvestorColumnKey, type InvestorDailyRow } from './investorDailyRows';

/** Join only matching dates and units. A partial total must never look complete. */
export function investorDailySummary(data: LivePastInvestorNetResponse | undefined,
  code: string, unit: InvestorNetUnit, side: InvestorTradeSide, dates: readonly string[]) {
  const valid = data?.code === code && (data.unit ?? 'qty_shares') === unit
    && (data.trade_side ?? 'net') === side;
  const byDate = new Map<string, InvestorDailyRow>();
  if (valid) {
    for (const row of buildInvestorDailyTable(data.points, 0).rows) byDate.set(row.date, row);
  }
  return {
    value: (date: string, key: InvestorColumnKey) => byDate.get(date)?.values[key] ?? null,
    total: (key: InvestorColumnKey): number | null => {
      if (!dates.length) return null;
      let total = 0;
      for (const date of dates) {
        const value = byDate.get(date)?.values[key];
        if (value == null) return null;
        total += value;
      }
      return total;
    },
  };
}

export function formatInvestorK(value: number, signed = false): string {
  const prefix = value < 0 ? '−' : signed && value > 0 ? '+' : '';
  const abs = Math.abs(value);
  if (abs > 0 && abs < 100) return `${prefix}<0.1K`;
  return `${prefix}${(abs / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })}K`;
}
