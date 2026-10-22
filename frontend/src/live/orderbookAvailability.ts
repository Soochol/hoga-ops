import type { LiveStatus } from '../api/liveStatus';
import type { LiveVenueOption } from '../state/liveVenue';

export type OrderbookAvailabilityKind = 'loading' | 'registering' | 'awaiting_book' | 'waiting_slot'
  | 'recovering' | 'unconfigured' | 'reference_limit' | 'query_error' | 'closed' | 'stale' | 'aftermarket_excluded';
export interface OrderbookAvailability {
  kind: OrderbookAvailabilityKind;
  message: string;
  detail?: string;
  action?: 'retry' | 'status';
  lastBookMs?: number;
}

/** Registration and orderbook arrivals are independent; a trade is never a book. */
export function deriveOrderbookAvailability(input: {
  code: string; venue: LiveVenueOption; nowMs: number; bookMs?: number;
  loading: boolean; error: unknown; status?: LiveStatus; statusCurrent: boolean;
  connected: boolean; referenceLimited: boolean;
}): OrderbookAvailability | null {
  const { code, venue, nowMs, bookMs, statusCurrent, connected } = input;
  const status = statusCurrent ? input.status : undefined;
  const kiwoom = status?.kiwoom;
  const view = kiwoom?.view_subscriptions?.find(row => row.code === code && row.venue === venue);
  const hasBook = bookMs !== undefined;
  // An actual current book wins over a slower status poll and metadata errors.
  if (hasBook && nowMs - bookMs >= -5_000 && nowMs - bookMs < 30_000) return null;
  let state: OrderbookAvailability;
  if (!hasBook && input.loading) state = { kind: 'loading', message: '호가 불러오는 중…' };
  else if (input.referenceLimited) state = { kind: 'reference_limit', message: '앱의 화면 구독 한도에 도달했습니다',
    detail: '불필요한 탭이나 목록을 닫은 뒤 이 탭을 새로고침해 주세요', action: 'status' };
  else if (kiwoom?.connection_allowed === false) {
    if (hasBook) return null;
    state = { kind: 'closed', message: '현재 표시할 호가가 없습니다', detail: '실시간 연결 운영 시간이 아닙니다', action: 'status' };
  } else if (status?.provider_status?.connection === 'unconfigured') {
    state = { kind: 'unconfigured', message: '실시간 시세 연결 설정이 필요합니다', action: 'status' };
  } else if (view?.phase === 'waiting_slot') state = { kind: 'waiting_slot', message: '실시간 구독 한도로 연결 대기 중',
    detail: '구독 슬롯이 반환되면 자동으로 연결됩니다', action: 'status' };
  else if (!hasBook && input.error) state = { kind: 'query_error', message: '호가 불러오기 실패', action: 'retry' };
  else if (!connected || view?.phase === 'waiting_connection'
    || (kiwoom?.collector && !kiwoom.collector.ready)) {
    state = { kind: 'recovering', message: '실시간 연결 복구 중', action: 'status' };
  } else if (view?.phase === 'registering') state = { kind: 'registering', message: '실시간 호가 연결 중…' };
  else if (hasBook) state = { kind: 'stale', message: '호가 수신 지연', action: 'status' };
  else {
    const wire = `${code}${venue === 'NXT' ? '_NX' : venue === 'UN' ? '_AL' : ''}`;
    const registered = view?.phase === 'registered' || kiwoom?.ready_registrations?.includes(wire);
    const receivedBook = kiwoom?.data_received_ms?.[`${code}:${venue}:ob`];
    state = registered
      ? { kind: 'awaiting_book', message: receivedBook ? '호가 수신 대기 중' : '첫 호가 수신 대기 중', action: 'status' }
      : { kind: 'registering', message: '실시간 호가 연결 중…', action: 'status' };
  }
  return hasBook ? { ...state, lastBookMs: bookMs } : state;
}
