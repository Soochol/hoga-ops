import type { TradingAccountId } from '../../api/trading';
import type { ApiError } from '../../api/client';
import { validOrderInput } from '../../state/orderWindowSettings';

export interface OrderNotice {
  title: string;
  message: string;
  tone: 'neutral' | 'warn' | 'error';
  persistent?: boolean;
  retry?: boolean;
}

/** The inline explanation and the command guard must use the same decision. */
export function newOrderIssue(input: {
  accountsLoading: boolean; configured: boolean; account: TradingAccountId; accountError: unknown;
  stateReady: boolean; stateError: unknown; busy: boolean; unresolved: boolean;
  settingsOpen: boolean; locked: boolean; stored: boolean; singlePrice: boolean;
  hasBook: boolean; fresh: boolean; quantity: number | null;
  brokerBlocked?: string | null;
}): OrderNotice | null {
  if (input.busy) return { title: '주문 처리 중', message: '진행 중인 요청의 결과를 기다리고 있습니다.', tone: 'neutral' };
  if (input.accountsLoading) return { title: '계좌 확인 중', message: '주문 계좌를 불러오고 있습니다.', tone: 'neutral' };
  const error = input.accountError ?? input.stateError;
  if (error) return { title: '계좌 확인 필요', message: error instanceof Error ? error.message : '계좌 조회에 실패했습니다.', tone: 'error' };
  if (!input.configured) return { title: '계좌 연결 필요', message: '토스증권 또는 키움증권의 API 인증 정보를 서버에 설정하세요.', tone: 'warn' };
  if (!input.account) return { title: '계좌 선택 필요', message: '주문할 계좌를 선택하세요.', tone: 'warn' };
  if (input.brokerBlocked) return { title: '주문 연결 확인 필요', message: input.brokerBlocked, tone: 'warn' };
  if (!input.stateReady) return { title: '계좌 확인 중', message: '주문 내역과 계좌 정보를 불러오고 있습니다.', tone: 'neutral' };
  if (input.unresolved) return { title: '주문 결과 확인 필요', message: '결과가 불명확한 요청이 있습니다. 해당 증권사의 주문·체결 내역을 확인하세요.', tone: 'error', persistent: true };
  if (input.settingsOpen) return { title: '주문 설정 중', message: '설정을 닫은 후 주문하세요.', tone: 'neutral' };
  if (input.locked) return { title: '주문 이동 중', message: '진행 중인 드래그를 마친 후 신규 주문을 넣으세요.', tone: 'neutral' };
  if (input.stored) return { title: '신규 주문 불가', message: '저장된 호가는 조회만 가능합니다.', tone: 'warn' };
  if (input.singlePrice) return { title: '신규 주문 불가', message: '현재 표시 중인 시간외 단일가 호가에서는 지정가 주문을 지원하지 않습니다.', tone: 'warn' };
  if (!input.hasBook) return { title: '주문 대기', message: '실시간 호가를 기다리고 있습니다.', tone: 'warn' };
  if (!input.fresh) return { title: '주문 대기', message: '실시간 호가가 오래되었습니다. 최신 호가를 기다리고 있습니다.', tone: 'warn' };
  if (input.quantity == null || !validOrderInput(input.quantity, 'quantity')) return {
    title: '신규 주문 불가', message: '주문 수량은 1주 이상 10억주 이하의 정수로 입력하세요.', tone: 'warn',
  };
  return null;
}

/** A broker rejection is final for that request; an uncertain write needs reconciliation. */
export function orderFailure(error: unknown, operation = '주문'): OrderNotice {
  const api = error as ApiError | null;
  const message = error instanceof Error ? error.message : '주문 처리 결과를 확인하세요.';
  if (api?.code === 'order-outcome-unknown' || api?.code === 'unresolved-order-exists'
    || (!api?.status && !api?.code) || (api?.status != null && api.status >= 500)) {
    return { title: `${operation} 결과 확인 필요`, message, tone: 'error', persistent: true,
      retry: api?.code !== 'unresolved-order-exists' };
  }
  return { title: `${operation} 접수 불가`, message, tone: 'warn' };
}
