import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { measureBookSummaryWidth } from './bookSummaryWidth';

type Budget = { symbol: string; qty: number; delta: number; price: number; trade: number; strength: string };
const digits = (value: number) => Number.isSafeInteger(value) ? String(Math.abs(value)).length : 1;
const sample = (length: number) => '8'.repeat(length).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Measure retained digit samples with the live data font, including CSS density
 * and window padding. Only a symbol change may shrink an observed digit budget. */
export function useBookSideLayout(symbol: string, quantities: readonly number[], deltas: readonly number[],
  trades: readonly { price: number; qty: number }[], strength: number | null) {
  const required: Budget = { symbol, qty: Math.max(1, ...quantities.map(digits)),
    delta: Math.max(4, ...deltas.map(digits)), price: Math.max(1, ...trades.map(t => digits(t.price))),
    trade: Math.max(1, ...trades.map(t => digits(t.qty))),
    strength: strength === null ? '888.88%' : `${strength.toFixed(2)}%`.replace(/\d/g, '8') };
  const [budget, setBudget] = useState(required);
  const next = budget.symbol !== symbol ? required : {
    symbol, qty: Math.max(budget.qty, required.qty), delta: Math.max(budget.delta, required.delta),
    price: Math.max(budget.price, required.price), trade: Math.max(budget.trade, required.trade),
    strength: required.strength.length > budget.strength.length ? required.strength : budget.strength,
  };
  if (Object.keys(next).some(key => next[key as keyof Budget] !== budget[key as keyof Budget])) setBudget(next);
  const node = useRef<HTMLSpanElement | null>(null);
  const summaryNode = useRef<HTMLDivElement | null>(null);
  const summaryBudget = useRef({ key: symbol, font: '', width: 0 });
  const observer = useRef<ResizeObserver | null>(null);
  const [measured, setMeasured] = useState({ side: 0, price: 0, summary: 0 });
  const measuredRef = useRef(measured);
  const measure = useCallback(() => {
    if (!node.current) return;
    const side = Math.ceil(node.current.getBoundingClientRect().width);
    const price = Math.ceil(node.current.querySelector('[data-book-trade-price]')!.getBoundingClientRect().width);
    summaryBudget.current = measureBookSummaryWidth(summaryNode.current, symbol, summaryBudget.current);
    const summary = summaryBudget.current.width;
    const previous = measuredRef.current;
    if (previous.side === side && previous.price === price && previous.summary === summary) return;
    measuredRef.current = { side, price, summary };
    setMeasured(measuredRef.current);
  }, [symbol]);
  const setProbe = useCallback((element: HTMLSpanElement | null) => {
    observer.current?.disconnect();
    node.current = element;
    if (!element) return;
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      observer.current = new ResizeObserver(measure);
      observer.current.observe(element);
    }
  }, [measure]);
  const setSummaryProbe = useCallback((element: HTMLDivElement | null) => {
    summaryNode.current = element;
    if (element) measure();
  }, [measure]);
  // Summary values and page changes need measurement even with the same digit budget.
  useLayoutEffect(measure);
  return { setProbe, setSummaryProbe, samples: { qty: sample(next.qty), delta: sample(next.delta), price: sample(next.price),
    trade: sample(next.trade), strength: next.strength },
    style: { '--book-side-content-width': `${measured.side}px`, '--book-trade-price-width': `${measured.price}px`,
      '--book-summary-content-width': `${measured.summary}px` } as CSSProperties };
}
