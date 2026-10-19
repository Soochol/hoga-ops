import { formatInvestorK } from '../investorDailySummary';
import type { InvestorNetUnit, InvestorTradeSide } from '../../api/types';
import { formatAmount, qtyClass } from '../../sidebar/InvestorTrendEstimateCardHelpers';
import { InvestorDailyNumber } from './InvestorDailyNumber';


const exactQuantity = new Intl.NumberFormat('en-US');
const exactAmount = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });

const labels = { net: '순매수', buy: '총매수', sell: '총매도' };
const sides = ['net', 'buy', 'sell'] as const;

export function InvestorDailySummaryCell({ values, unit, useK = true, foot = false, divided = true, showUnitSuffix = true, aligned = false }: {
  values: Record<InvestorTradeSide, number | null>;
  unit: InvestorNetUnit;
  useK?: boolean;
  foot?: boolean;
  divided?: boolean;
  showUnitSuffix?: boolean;
  aligned?: boolean;
}) {
  return <td className={`whitespace-nowrap px-2 py-1 text-right ${divided ? 'border-l border-border' : ''} ${foot ? 'border-t border-border bg-bg-card' : ''}`}>
    <div className={`grid items-baseline gap-x-1 tabular-nums ${aligned
      ? 'grid-cols-[minmax(0,1fr)_0.5ch_minmax(0,1fr)_0.5ch_minmax(0,1fr)]'
      : 'grid-cols-[minmax(7ch,1fr)_auto_minmax(7ch,1fr)_auto_minmax(7ch,1fr)]'}`}>
      {sides.map((side, index) => {
        const value = values[side];
        const amount = value === null ? null : unit === 'amt_eok' ? value : value / 100;
        const exact = value === null ? '데이터 없음' : unit === 'qty_shares'
          ? `${exactQuantity.format(value)}주` : `${exactAmount.format(amount!)}억원`;
        const formatted = value === null ? '—' : unit === 'qty_shares'
          ? useK ? formatInvestorK(value, side === 'net')
            : `${side === 'net' && value > 0 ? '+' : ''}${exactQuantity.format(value)}`
          : formatAmount(unit === 'amt_eok' ? value * 100 : value);
        const number = showUnitSuffix ? formatted : formatted.replace(/[K억]$/, '');
        const text = side === 'net' ? number : number.replace(/^\+/, '');
        return <span key={side} className="contents">
          {index > 0 && <span aria-hidden="true" className="text-fg-dimmer">·</span>}
          <span title={`${labels[side]} ${exact}`} aria-label={`${labels[side]} ${exact}`}
            className={value === null ? 'text-fg-dimmer' : side === 'net' ? `font-semibold ${qtyClass(value)}`
              : 'text-fg-dim'}>
            {aligned && !showUnitSuffix ? <InvestorDailyNumber text={text} amount={unit !== 'qty_shares'} /> : text}
          </span>
        </span>;
      })}
    </div>
  </td>;
}
