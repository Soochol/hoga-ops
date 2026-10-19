import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { TradingAccountId } from '../../api/trading';

const COLUMNS = ['quantity', 'average', 'value', 'profit', 'percent'] as const;
type Column = typeof COLUMNS[number];
type Figures = Record<Column, readonly string[]>;
function mapColumns<T>(read: (column: Column) => T): Record<Column, T> {
  return { quantity: read('quantity'), average: read('average'), value: read('value'), profit: read('profit'), percent: read('percent') };
}
const empty = (): Figures => ({ quantity: [], average: [], value: [], profit: [], percent: [] });
const patterns = (values: readonly string[]) => [...new Set(['—', ...values].map(value => value.replace(/\d/g, '8')))];

/** The panel owns this memory so closing the list or switching tabs does not
 * discard the account's observed figures. Another account starts a fresh budget. */
export function useHoldingColumnMemory(account: TradingAccountId) {
  const [budget, setBudget] = useState(() => ({ account, figures: empty() }));
  if (budget.account !== account) setBudget({ account, figures: empty() });
  return [budget, setBudget] as const;
}

export function useHoldingColumns([budget, retain]: ReturnType<typeof useHoldingColumnMemory>, values: Figures) {
  const next = useMemo(() => {
    const figures = mapColumns(column => [...new Set([...budget.figures[column], ...patterns(values[column])])]);
    return COLUMNS.some(column => figures[column].length !== budget.figures[column].length)
      ? { account: budget.account, figures } : budget;
  }, [budget, values]);
  // Persist in the panel after commit; the child never updates its parent in render.
  useLayoutEffect(() => { if (next !== budget) retain(next); }, [budget, next, retain]);
  const node = useRef<HTMLSpanElement | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const [widths, setWidths] = useState<Record<Column, number>>({ quantity: 0, average: 0, value: 0, profit: 0, percent: 0 });
  const measure = useCallback(() => {
    if (!node.current) return;
    const measured = mapColumns(column => Math.ceil(Math.max(0,
      ...Array.from(node.current!.querySelectorAll(`[data-holding-measure="${column}"]`), el => el.getBoundingClientRect().width),
    )));
    setWidths(old => COLUMNS.every(column => old[column] === measured[column]) ? old : measured);
  }, []);
  const refreshProbe = useCallback(() => {
    observer.current?.disconnect();
    const element = node.current;
    if (!element) return;
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      observer.current = new ResizeObserver(measure);
      observer.current.observe(element);
      element.querySelectorAll('[data-holding-measure]').forEach(probe => observer.current!.observe(probe));
    }
  }, [measure]);
  const setProbe = useCallback((element: HTMLSpanElement | null) => { node.current = element; refreshProbe(); }, [refreshProbe]);
  useLayoutEffect(refreshProbe, [next, refreshProbe]);
  return { setProbe, samples: next.figures, style: Object.fromEntries(COLUMNS.map(column =>
    [`--account-holding-${column}-width`, `${widths[column]}px`])) as CSSProperties };
}
