import { useTextTooltip } from '../../ui/useTextTooltip';
import './OrderSurface.css';

const eokAmountFormat = new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Both ladders use the displayed level's quantity, including a valid zero balance. */
export function BookPriceAmount({ price, qty }: { price: number; qty: number }) {
  const amount = price * qty;
  const valid = price > 0 && Number.isSafeInteger(price) && qty >= 0 && Number.isSafeInteger(qty) && Number.isSafeInteger(amount);
  const tooltip = useTextTooltip(valid ? `${eokAmountFormat.format(amount / 100_000_000)}억` : '', 500, 'order-tooltip', true);
  return <>
    <span className="book-price-amount" aria-describedby={tooltip.id}
      onMouseEnter={event => tooltip.show(event.currentTarget)} onMouseLeave={tooltip.hide}>
      {price > 0 ? price.toLocaleString('ko-KR') : '—'}
    </span>
    {tooltip.tooltip}
  </>;
}
