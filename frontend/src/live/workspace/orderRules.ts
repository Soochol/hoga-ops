import type { TossOrder } from '../../api/trading';

export const ORDER_ROW_HEIGHT = 24;
export const HIGH_VALUE_WON = 100_000_000;
export const editableOrder = (order: TossOrder) => ['PENDING', 'PARTIAL_FILLED'].includes(order.status);
export const orderRemainder = (order: TossOrder) => Math.max(0, Number(order.quantity) - Number(order.execution.filledQuantity));
export const orderSideLabel = (side: string) => side === 'BUY' ? '매수' : '매도';

function exactHoldingCost(quantity: number | null, averagePrice: string | null | undefined) {
  if (quantity == null || !Number.isSafeInteger(quantity) || quantity < 1
    || averagePrice == null || averagePrice.length > 128) return null;
  const decimal = /^(\d+)(?:\.(\d+))?$/.exec(averagePrice);
  if (!decimal) return null;
  const fraction = decimal[2] ?? '';
  const scale = 10n ** BigInt(fraction.length);
  const cost = BigInt(decimal[1]) * scale + BigInt(fraction || '0');
  return { amount: cost * BigInt(quantity), scale, quantity: BigInt(quantity) };
}

/** Compare the original decimal cost; ties select the lower displayed price. */
export function holdingBookMarker(quantity: number | null, averagePrice: string | null | undefined, prices: Iterable<number>) {
  const hidden = { price: null, outside: false };
  const cost = exactHoldingCost(quantity, averagePrice);
  if (!cost || cost.amount <= 0n) return hidden;
  const scale = cost.scale * cost.quantity;
  let nearest: number | null = null, distance: bigint | null = null;
  let min: bigint | null = null, max: bigint | null = null;
  for (const price of prices) {
    if (!Number.isSafeInteger(price) || price <= 0) continue;
    const scaled = BigInt(price) * scale;
    const delta = scaled - cost.amount;
    const absolute = delta < 0n ? -delta : delta;
    if (distance === null || absolute < distance || (absolute === distance && (nearest === null || price < nearest))) {
      nearest = price; distance = absolute;
    }
    if (min === null || scaled < min) min = scaled;
    if (max === null || scaled > max) max = scaled;
  }
  if (min === null || max === null) return hidden;
  const outside = cost.amount < min || cost.amount > max;
  return { price: outside ? null : nearest, outside };
}

function ceilWon(amount: bigint, scale: bigint): number | null {
  // BigInt division truncates toward zero; only positive remainders need +1.
  const rounded = Number(amount / scale + (amount % scale > 0n ? 1n : 0n));
  return Number.isSafeInteger(rounded) ? rounded : null;
}

/** Original average cost × current holding quantity, rounded up to whole won. */
export function holdingPurchaseAmountWon(quantity: number | null, averagePrice: string | null | undefined): number | null {
  if (quantity === 0) return 0;
  const cost = exactHoldingCost(quantity, averagePrice);
  return cost ? ceilWon(cost.amount, cost.scale) : null;
}

/** Whole-won ceiling of unrealized P/L, retaining the API's exact decimal cost. */
export function holdingProfitWon(quantity: number | null, price: number | null, averagePrice: string | null | undefined): number | null {
  if (quantity === 0) return 0;
  if (price == null || !Number.isSafeInteger(price) || price <= 0) return null;
  const cost = exactHoldingCost(quantity, averagePrice);
  return cost ? ceilWon(BigInt(price) * cost.scale * cost.quantity - cost.amount, cost.scale) : null;
}

/** P/L as a percentage of the exact purchase cost, rounded to two decimals. */
export function holdingProfitPercent(quantity: number | null, price: number | null, averagePrice: string | null | undefined): number | null {
  if (price == null || !Number.isSafeInteger(price) || price <= 0) return null;
  const cost = exactHoldingCost(quantity, averagePrice);
  if (!cost || cost.amount <= 0n) return null;
  const profit = BigInt(price) * cost.scale * cost.quantity - cost.amount;
  const magnitude = profit < 0n ? -profit : profit;
  const hundredths = (magnitude * 10_000n * 2n + cost.amount) / (cost.amount * 2n);
  const rounded = Number(profit < 0n ? -hundredths : hundredths);
  return Number.isSafeInteger(rounded) ? rounded / 100 : null;
}

export const orderStatusLabel = (status: string) => ({
  PENDING: '체결 대기', PARTIAL_FILLED: '부분 체결', PENDING_CANCEL: '취소 중', PENDING_REPLACE: '정정 중',
  EXPIRED: '기간 만료', FILLED: '체결 완료', CANCELED: '취소 완료', REPLACED: '정정 완료', REJECTED: '주문 거절',
  CANCEL_REJECTED: '취소 거절', REPLACE_REJECTED: '정정 거절',
}[status] ?? `상태 확인 필요 (${status})`);

export function groupPriceOrders(orders: readonly TossOrder[]) {
  const groups = new Map<string, TossOrder[]>();
  for (const order of orders) {
    if (order.price === null) continue;
    const key = `${order.side}:${Number(order.price)}`;
    const group = groups.get(key) ?? [];
    group.push(order);
    groups.set(key, group);
  }
  return groups;
}
