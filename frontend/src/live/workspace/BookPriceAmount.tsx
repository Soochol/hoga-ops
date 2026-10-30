import type { ReactNode } from 'react';
import { useTextTooltip } from '../../ui/useTextTooltip';
import './OrderSurface.css';

const eokAmountFormat = new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Both ladders use the displayed level's quantity, including a valid zero balance. */
export function BookAmountTooltip({ price, qty, className, children }: {
  price: number; qty: number; className: string; children: ReactNode;
}) {
  const amount = price * qty;
  const valid = price > 0 && Number.isSafeInteger(price) && qty >= 0 && Number.isSafeInteger(qty) && Number.isSafeInteger(amount);
  const tooltip = useTextTooltip(valid ? `${eokAmountFormat.format(amount / 100_000_000)}억` : '', 500, 'order-tooltip', true);
  return <>
    <span className={className} aria-describedby={tooltip.id}
      onMouseEnter={event => tooltip.show(event.currentTarget)} onMouseLeave={tooltip.hide}>
      {children}
    </span>
    {tooltip.tooltip}
  </>;
}

export function BookPriceAmount({ price, qty }: { price: number; qty: number }) {
  return <BookAmountTooltip price={price} qty={qty} className="book-price-amount">
    {price > 0 ? price.toLocaleString('ko-KR') : '—'}
  </BookAmountTooltip>;
}
