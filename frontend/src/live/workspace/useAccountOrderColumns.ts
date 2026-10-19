import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { TradingAccountId } from '../../api/trading';

const patterns = (values: readonly string[]) => [...new Set(['—', ...values].map(value => value.replace(/\d/g, '8')))];
type Samples = { account: TradingAccountId; price: string[]; quantity: string[] };

/** Observe the unfiltered account list. Keep formatted digit/separator patterns
 * after fills and removals, while allowing an account change to reset them. */
export function useAccountOrderColumns(account: TradingAccountId, prices: readonly string[], quantities: readonly string[]) {
  const required: Samples = { account, price: patterns(prices), quantity: patterns(quantities) };
  const [budget, setBudget] = useState(required);
  const next = budget.account !== account ? required : { account,
    price: [...new Set([...budget.price, ...required.price])], quantity: [...new Set([...budget.quantity, ...required.quantity])] };
  if (budget.account !== account || next.price.length !== budget.price.length || next.quantity.length !== budget.quantity.length) setBudget(next);
  const node = useRef<HTMLSpanElement | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const [widths, setWidths] = useState({ price: 0, quantity: 0, side: 0, cancel: 0 });
  const measure = useCallback(() => {
    if (!node.current) return;
    const width = (column: string) => Math.ceil(Math.max(0, ...Array.from(node.current!.querySelectorAll(`[data-order-measure="${column}"]`),
      el => el.getBoundingClientRect().width)));
    const measured = { price: width('price'), quantity: width('quantity'), side: width('side'), cancel: width('cancel') };
    setWidths(old => Object.keys(measured).every(key => measured[key as keyof typeof measured] === old[key as keyof typeof old]) ? old : measured);
  }, []);
  const refreshProbe = useCallback(() => {
    observer.current?.disconnect();
    const element = node.current;
    if (!element) return;
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      observer.current = new ResizeObserver(measure);
      observer.current.observe(element);
      element.querySelectorAll('[data-order-measure]').forEach(probe => observer.current!.observe(probe));
    }
  }, [measure]);
  const setProbe = useCallback((element: HTMLSpanElement | null) => {
    node.current = element;
    refreshProbe();
  }, [refreshProbe]);
  useLayoutEffect(refreshProbe, [budget, refreshProbe]);
  return { setProbe, samples: { price: next.price, quantity: next.quantity }, style: {
    '--account-order-price-width': `${widths.price}px`, '--account-order-quantity-width': `${widths.quantity}px`,
    '--account-order-side-width': `${widths.side}px`, '--account-order-cancel-width': `${widths.cancel}px`,
  } as CSSProperties };
}
