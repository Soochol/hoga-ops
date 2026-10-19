import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

const digits = (n: number) => Number.isSafeInteger(n) ? String(Math.abs(n)).length : 1;
const figure = (n: number) => '8'.repeat(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
type Budget = { key: string; qty: number; delta: number; price: number; trade: number;
  order: number; count: number; pending: boolean; strength: string };

/** Retain observed widths for a Code/account, so disappearing badges and fills
 * do not move the order targets. CSS supplies the live font and spacing. */
export function useOrderColumnLayout(key: string, quantities: number[], deltas: number[],
  trades: readonly { price: number; qty: number }[], strength: number | null,
  orderQuantities: number[], orderCount: number, pending: boolean) {
  const required: Budget = { key, qty: Math.max(1, ...quantities.map(digits)), delta: Math.max(4, ...deltas.map(digits)),
    price: Math.max(1, ...trades.map(t => digits(t.price))), trade: Math.max(1, ...trades.map(t => digits(t.qty))),
    order: Math.max(1, ...orderQuantities.map(digits)), count: digits(orderCount), pending,
    strength: strength == null ? '888.88%' : `${strength.toLocaleString('ko-KR')}%`.replace(/\d/g, '8') };
  const [budget, setBudget] = useState(required);
  const next = budget.key !== key ? required : { key,
    qty: Math.max(budget.qty, required.qty), delta: Math.max(budget.delta, required.delta),
    price: Math.max(budget.price, required.price), trade: Math.max(budget.trade, required.trade),
    order: Math.max(budget.order, required.order), count: Math.max(budget.count, required.count),
    pending,
    strength: required.strength.length > budget.strength.length ? required.strength : budget.strength };
  if (Object.keys(next).some(k => next[k as keyof Budget] !== budget[k as keyof Budget])) setBudget(next);
  const node = useRef<HTMLSpanElement | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const [sizes, setSizes] = useState({ depth: 0, lane: 0, price: 0 });
  const measure = useCallback(() => {
    if (!node.current) return;
    const max = (selector: string) => Math.ceil(Math.max(0, ...Array.from(node.current!.querySelectorAll(selector),
      el => el.getBoundingClientRect().width)));
    const measured = { depth: max('[data-depth-probe]'), lane: max('[data-lane-probe]') + 6,
      price: max('[data-trade-price-probe]') };
    setSizes(old => old.depth === measured.depth && old.lane === measured.lane && old.price === measured.price ? old : measured);
  }, []);
  const setProbe = useCallback((element: HTMLSpanElement | null) => {
    observer.current?.disconnect(); node.current = element;
    if (!element) return;
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      observer.current = new ResizeObserver(measure);
      observer.current.observe(element);
      // The lane may be widest. Observe depth rows too, so their responsive
      // padding is measured even when the outer probe's width does not change.
      element.querySelectorAll('[data-depth-probe], [data-trade-price-probe]').forEach(probe => observer.current!.observe(probe));
    }
  }, [measure]);
  useLayoutEffect(measure, [budget, measure]);
  return { setProbe, samples: { qty: figure(next.qty), delta: figure(next.delta), price: figure(next.price),
    trade: figure(next.trade), strength: next.strength, order: `${figure(next.order)}${next.pending ? ' · 처리 중' : ''}`,
    total: `${figure(next.order)}(${figure(next.count)})` },
  style: { '--order-depth-content-width': `${sizes.depth}px`, '--order-lane-content-width': `${sizes.lane}px`,
    '--order-trade-price-width': `${sizes.price}px` } as CSSProperties };
}
