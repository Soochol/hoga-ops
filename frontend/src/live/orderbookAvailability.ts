import type { LiveStatus } from '../api/liveStatus';
import type { LiveVenueOption } from '../state/liveVenue';

export type OrderbookAvailabilityKind = 'loading' | 'registering' | 'awaiting_book' | 'waiting_slot'
  | 'recovering' | 'unconfigured' | 'reference_limit' | 'query_error' | 'closed' | 'stale' | 'aftermarket_excluded'
  | 'display_delayed' | 'timestamp_old' | 'status_error' | 'rest_error' | 'storage_error'
  | 'provider_error' | 'empty' | 'single_price_error' | 'saved_error';
export type BookRetryTarget = 'series' | 'status' | 'last_orderbook' | 'single_price' | 'saved_regular';
export interface BookIssue {
  kind: OrderbookAvailabilityKind;
  message: string;
  detail?: string;
  action?: 'retry' | 'status';
  retryTarget?: BookRetryTarget;
  quiet?: boolean;
}
export interface BookDiagnostics {
  code: string;
  venue: LiveVenueOption;
  bookMs?: number;
  browserReceivedMs?: number;
  serverReceivedMs?: number;
  serverObservedMs?: number;
  checkedAtMs: number;
  message: string;
}
export interface OrderbookAvailability extends BookIssue {
  lastBookMs?: number;
  lastBookClock?: string;
  diagnostics?: BookDiagnostics;
  /** All observed causes, ordered by their effect on the displayed book. */
  issues?: BookIssue[];
}

const PRIORITY: Record<BookIssue['kind'], number> = {
  reference_limit: 100, unconfigured: 100, recovering: 95, waiting_slot: 90,
  display_delayed: 85, query_error: 80, rest_error: 80, single_price_error: 80, saved_error: 80,
  status_error: 60, provider_error: 55, storage_error: 50, aftermarket_excluded: 40,
  closed: 35, loading: 30, registering: 25, awaiting_book: 20, empty: 15, stale: 10, timestamp_old: 10,
};

/** Keep secondary causes for details; only one cause owns the visible notice. */
export function combineBookAvailability(states: (OrderbookAvailability | null | undefined)[]): OrderbookAvailability | null {
  const present = states.filter((state): state is OrderbookAvailability => state != null);
  if (!present.length) return null;
  const issues = present.flatMap(state => state.issues ?? [state])
    .filter((issue, index, all) => all.findIndex(other => other.kind === issue.kind && other.retryTarget === issue.retryTarget) === index)
    .sort((a, b) => PRIORITY[b.kind] - PRIORITY[a.kind]);
  const primary = issues[0];
  return { ...primary, quiet: primary.quiet === true, issues,
    lastBookMs: present.find(state => state.lastBookMs !== undefined)?.lastBookMs,
    lastBookClock: present.find(state => state.lastBookClock != null)?.lastBookClock,
    diagnostics: present.find(state => state.diagnostics)?.diagnostics };
}

export const BOOK_STALE_MS = 30_000;
export function recentBookEvidence(at: number | undefined, now: number): boolean {
  return at !== undefined && Number.isFinite(at) && now - at >= -5_000 && now - at < BOOK_STALE_MS;
}

/** Registration and orderbook arrivals are independent; a trade is never a book. */
export function deriveOrderbookAvailability(input: {
  code: string; venue: LiveVenueOption; nowMs: number; bookMs?: number;
  loading: boolean; error: unknown; status?: LiveStatus; statusCurrent: boolean;
  connected: boolean; referenceLimited: boolean;
  statusFailed?: boolean;
  browserReceivedMs?: number;
}): OrderbookAvailability | null {
  const { code, venue, nowMs, bookMs, statusCurrent, connected } = input;
  const status = statusCurrent ? input.status : undefined;
  const kiwoom = status?.kiwoom;
  const view = kiwoom?.view_subscriptions?.find(row => row.code === code && row.venue === venue);
  const wire = `${code}${venue === 'NXT' ? '_NX' : venue === 'UN' ? '_AL' : ''}`;
  const registered = view?.phase === 'registered' || kiwoom?.ready_registrations?.includes(wire);
  const serverReceived = kiwoom?.data_received_ms?.[`${code}:${venue}:ob`];
  const hasBook = bookMs !== undefined;
  // An actual current book wins over a slower status poll and metadata errors.
  if (recentBookEvidence(bookMs, nowMs)) return null;
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
  else if (!hasBook && input.error) state = { kind: 'query_error', message: '호가 불러오기 실패',
    detail: '실시간 호가 이력을 조회하지 못했습니다. 기존 호가가 있으면 유지합니다.', action: 'retry', retryTarget: 'series' };
  else if (!connected || view?.phase === 'waiting_connection'
    || (kiwoom?.collector && !kiwoom.collector.ready)) {
    state = { kind: 'recovering', message: '실시간 연결 복구 중', action: 'status' };
  } else if (view?.phase === 'registering') state = { kind: 'registering', message: '실시간 호가 연결 중…' };
  else if (recentBookEvidence(serverReceived, nowMs) && !recentBookEvidence(input.browserReceivedMs, nowMs)) {
    state = { kind: 'display_delayed', message: '화면 호가 갱신 지연',
      detail: '서버의 최근 호가 수신을 확인했습니다. 화면의 최신 호가 확인이 필요합니다', action: 'status', retryTarget: 'series' };
  } else if (hasBook) {
    if (recentBookEvidence(input.browserReceivedMs, nowMs)) {
      state = { kind: 'timestamp_old', message: '호가 시각 갱신 대기',
        detail: '호가는 수신 중이며 호가 시각은 아직 갱신되지 않았습니다', action: 'status' };
    } else if (registered && !input.error && status?.provider_status?.connection === 'connected'
      && status.provider_status.failures?.length === 0 && !kiwoom?.collector?.error
      && !kiwoom?.collector?.storage_errors?.length) {
      // A quiet book is not itself a failure; only soften copy with current health evidence.
      state = { kind: 'stale', message: '호가 갱신 대기 중',
        detail: '새 호가가 수신되면 자동으로 갱신됩니다', action: 'status' };
    } else state = { kind: 'stale', message: '호가 갱신 확인 중',
      detail: status ? '최근 호가 수신이 없습니다. 호가가 뜸한 경우와 수신 중단을 아직 구분할 수 없습니다'
        : '현재 서버의 호가 수신 상태를 확인할 수 없습니다', action: 'status' };
  } else {
    const receivedBook = kiwoom?.data_received_ms?.[`${code}:${venue}:ob`];
    state = registered
      ? { kind: 'awaiting_book', message: receivedBook ? '호가 수신 대기 중' : '첫 호가 수신 대기 중', action: 'status' }
      : { kind: 'registering', message: '실시간 호가 연결 중…', action: 'status' };
  }
  const provider = status?.provider_status;
  const states: OrderbookAvailability[] = [{ ...state, lastBookMs: bookMs,
    quiet: hasBook && (state.kind === 'stale' || state.kind === 'timestamp_old') }];
  if (input.error) states.push({ kind: 'query_error', message: '호가 불러오기 실패',
    detail: '실시간 호가 이력을 조회하지 못했습니다. 기존 호가가 있으면 유지합니다.', action: 'retry', retryTarget: 'series' });
  if (input.statusFailed) states.push({ kind: 'status_error', message: '호가 수신 상태 확인 실패',
    detail: '연결 상태 조회에 실패했습니다. 호가 수신 중단이 확인된 것은 아닙니다.', action: 'status', retryTarget: 'status' });
  if (provider?.failures?.length || (provider && ['connecting', 'unavailable', 'partial'].includes(provider.connection))
    || kiwoom?.collector?.error) states.push({ kind: 'provider_error', message: '실시간 시세 서비스 확인 필요',
    detail: '서비스에서 오류가 관측됐습니다. 이 종목의 호가 수신 상태는 상세에서 확인하세요.', action: 'status' });
  if (kiwoom?.collector?.storage_errors?.length) states.push({ kind: 'storage_error', message: '실시간 데이터 저장 실패',
    detail: '서버 저장 오류가 관측됐습니다. 호가 수신 여부와는 별개입니다.', action: 'status' });
  return combineBookAvailability(states);
}
