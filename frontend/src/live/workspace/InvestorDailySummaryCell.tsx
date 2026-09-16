import { formatInvestorK } from '../investorDailySummary';
import type { InvestorNetUnit, InvestorTradeSide } from '../../api/types';
import { formatAmount, qtyClass } from '../../sidebar/InvestorTrendEstimateCard';


const labels = { net: '순매수', buy: '총매수', sell: '총매도' };
const sides = ['net', 'buy', 'sell'] as const;

export function InvestorDailySummaryCell({ values, unit, useK = true, foot = false, divided = true }: {
  values: Record<InvestorTradeSide, number | null>;
  unit: InvestorNetUnit;
  useK?: boolean;
  foot?: boolean;
  divided?: boolean;
}) {
  return <td className={`whitespace-nowrap px-2 py-1 text-right ${divided ? 'border-l border-border' : ''} ${foot ? 'border-t border-border bg-bg-card' : ''}`}>
    <div className="grid grid-cols-[minmax(7ch,1fr)_auto_minmax(7ch,1fr)_auto_minmax(7ch,1fr)] items-baseline gap-x-1 tabular-nums">
      {sides.map((side, index) => {
        const value = values[side];
        const amount = value === null ? null : unit === 'amt_eok' ? value : value / 100;
        const exact = value === null ? '데이터 없음' : unit === 'qty_shares'
          ? `${value.toLocaleString('en-US')}주` : `${amount!.toLocaleString('en-US', { maximumFractionDigits: 6 })}억원`;
        const formatted = value === null ? '—' : unit === 'qty_shares'
          ? useK ? formatInvestorK(value, side === 'net')
            : `${side === 'net' && value > 0 ? '+' : ''}${value.toLocaleString('en-US')}`
          : formatAmount(unit === 'amt_eok' ? value * 100 : value);
        const text = side === 'net' ? formatted : formatted.replace(/^\+/, '');
        return <span key={side} className="contents">
          {index > 0 && <span aria-hidden="true" className="text-fg-dimmer">·</span>}
          <span title={`${labels[side]} ${exact}`} aria-label={`${labels[side]} ${exact}`}
            className={value === null ? 'text-fg-dimmer' : side === 'net' ? `font-semibold ${qtyClass(value)}`
              : `${side === 'buy' ? 'text-price-up' : 'text-price-down'} opacity-90`}>
            {text}
          </span>
        </span>;
      })}
    </div>
  </td>;
}
