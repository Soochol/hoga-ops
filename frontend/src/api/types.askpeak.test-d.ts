import type { AskPeak } from './types';

const _full: AskPeak = {
  date: '20260613',
  price: 1,
  qty: 2,
  t_ms: 3,
  max_price: 4,
  max_qty: 5,
  max_t_ms: 6,
};
void _full;

// @ts-expect-error max_price/max_qty/max_t_ms 누락
const _missing: AskPeak = { date: '20260613', price: 1, qty: 2, t_ms: 3 };
void _missing;
