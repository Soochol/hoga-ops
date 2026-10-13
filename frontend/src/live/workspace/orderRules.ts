import type { TossOrder } from '../../api/trading';

export const ORDER_ROW_HEIGHT = 24;
export const HIGH_VALUE_WON = 100_000_000;
export const editableOrder = (order: TossOrder) => ['PENDING', 'PARTIAL_FILLED'].includes(order.status);
export const orderRemainder = (order: TossOrder) => Math.max(0, Number(order.quantity) - Number(order.execution.filledQuantity));
export const orderSideLabel = (side: string) => side === 'BUY' ? '매수' : '매도';
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
