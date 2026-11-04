import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { tradingCommand, type CreateTradingOrder, type TradingAccountId, type TradingCommandResponse } from '../../api/trading';
import { pauseTradingRefresh } from '../../api/tradingRefresh';
import { orderFailure, type OrderNotice } from './orderFeedback';
import type { OrderReceipt } from './OrderStatusBar';
import { notifyOrderReceiptAccepted, prepareOrderReceiptSound } from './orderReceiptSound';

type CreateSnapshot = { readonly body: Readonly<CreateTradingOrder>; readonly sound: boolean; readonly name: string };
type CreateFailure = { notice: OrderNotice; unknown: boolean; followupMessage: string | null };
export type CreateOrderRecord = CreateSnapshot & (
  | { status: 'pending'; failure: CreateFailure | null }
  | { status: 'failed'; failure: CreateFailure }
  | { status: 'accepted'; receipt: OrderReceipt }
);

export function useCreateOrders() {
  const client = useQueryClient();
  const current = useRef<ReadonlyMap<string, CreateOrderRecord>>(new Map());
  const [records, setRecords] = useState(current.current);

  function replace(id: string, record: CreateOrderRecord | null) {
    const next = new Map(current.current);
    if (record) next.set(id, record);
    else next.delete(id);
    current.current = next;
    setRecords(next);
  }

  function submit(snapshot: CreateSnapshot, expected?: CreateOrderRecord) {
    const id = snapshot.body.command_id;
    const previous = current.current.get(id);
    if (expected ? previous !== expected || expected.status !== 'failed' : previous != null) return false;
    const failureBeforeRetry = previous?.status === 'failed' ? previous.failure : null;
    const pending: CreateOrderRecord = { ...snapshot, status: 'pending', failure: failureBeforeRetry };
    replace(id, pending);
    const resume = pauseTradingRefresh(client, 'live', snapshot.body.account_seq);
    if (snapshot.sound) prepareOrderReceiptSound();
    void (async () => {
      try {
        await tradingCommand<TradingCommandResponse>('/orders', snapshot.body, 'live');
        const accepted: CreateOrderRecord = { ...snapshot, status: 'accepted',
          receipt: { text: '주문 요청 접수됨', commandId: id } };
        replace(id, accepted);
        if (snapshot.sound) {
          const soundFailed = () => {
            if (current.current.get(id) !== accepted) return;
            replace(id, { ...accepted, receipt: { ...accepted.receipt,
              text: '주문은 접수됐지만 알림음을 재생하지 못했습니다', soundFailed: true } });
          };
          void notifyOrderReceiptAccepted(snapshot.body.account_seq, id).then(started => {
            if (!started) soundFailed();
          }, soundFailed);
        }
      } catch (error) {
        const notice = orderFailure(error);
        const unknown = !!notice.persistent && !!notice.retry;
        replace(id, { ...snapshot, status: 'failed', failure: failureBeforeRetry?.unknown
          ? { ...failureBeforeRetry, followupMessage: notice.message }
          : { notice: { ...notice, persistent: unknown }, unknown, followupMessage: null } });
      } finally { resume(); }
    })();
    return true;
  }

  return {
    records: [...records.values()], submit,
    active: () => [...current.current.values()].some(record => record.status === 'pending'),
    unknown: (account: TradingAccountId, code: string) => [...current.current.values()].some(record =>
      record.body.account_seq === account && record.body.code === code && record.status !== 'accepted' && record.failure?.unknown),
    reportFollowup: (expected: CreateOrderRecord, message: string) => {
      if (current.current.get(expected.body.command_id) !== expected || expected.status !== 'failed') return;
      replace(expected.body.command_id, { ...expected, failure: { ...expected.failure, followupMessage: message } });
    },
    consume: (expected: CreateOrderRecord) => {
      if (current.current.get(expected.body.command_id) !== expected || expected.status === 'pending'
        || (expected.status === 'failed' && expected.failure.unknown)) return;
      replace(expected.body.command_id, null);
    },
    reviewed: (id: string) => {
      const record = current.current.get(id);
      if (record?.status === 'failed' && record.failure.unknown) replace(id, null);
    },
  };
}
