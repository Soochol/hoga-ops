import type { RestOrderbookResponse } from '../api/liveRestOrderbook';
import { combineBookAvailability, type BookRetryTarget, type OrderbookAvailability } from './orderbookAvailability';

export interface BookQueryObservation {
  target: Extract<BookRetryTarget, 'single_price' | 'saved_regular'>;
  loading: boolean;
  error: boolean;
  retry: () => unknown;
}
export interface RestBookObservation {
  enabled: boolean;
  loading: boolean;
  isError: boolean;
  data?: RestOrderbookResponse;
  retry: () => unknown;
}

/** Normalize only the selected sources. Old cache entries from another subject are ignored. */
export function resolveBookAvailability({ live, rest, query, code, venue, hasBook }: {
  live: OrderbookAvailability | null; rest?: RestBookObservation; query?: BookQueryObservation;
  code: string; venue: string; hasBook: boolean;
}): OrderbookAvailability | null {
  const states: (OrderbookAvailability | null)[] = [];
  let restHasBook = false;
  if (rest?.enabled) {
    const data = rest.data?.code === code && rest.data.venue === venue ? rest.data : undefined;
    restHasBook = !!data?.book;
    if (rest.isError || data?.refresh_failed) states.push({ kind: 'rest_error',
      message: data?.book ? '최신 호가 조회 실패' : '마지막 호가 조회 실패',
      detail: data?.book ? '마지막으로 확인한 호가를 유지하고 있습니다.' : 'REST 마지막 호가를 조회하지 못했습니다.',
      action: 'retry', retryTarget: 'last_orderbook', lastBookClock: data?.book?.book_time ?? undefined });
    if (data?.storage_failed) states.push({ kind: 'storage_error', message: '호가 저장 실패',
      detail: '표시할 호가는 받았지만 저장하지 못했습니다. 다시 조회하면 저장도 다시 시도합니다.',
      action: 'retry', retryTarget: 'last_orderbook', lastBookClock: data.book?.book_time ?? undefined });
    if (!hasBook && !data?.book && !states.length) states.push(rest.loading
      ? { kind: 'loading', message: '마지막 호가 불러오는 중…' }
      : { kind: 'empty', message: '저장된 마지막 호가가 없습니다', action: 'retry', retryTarget: 'last_orderbook' });
  } else states.push(live);
  if (!restHasBook && query?.error) states.push({ kind: query.target === 'single_price' ? 'single_price_error' : 'saved_error',
    message: query.target === 'single_price' ? '시간외 호가 조회 실패' : '저장 호가 조회 실패',
    detail: hasBook ? '기존 호가를 유지하고 있습니다.' : '선택한 호가를 조회하지 못했습니다.',
    action: 'retry', retryTarget: query.target });
  else if (query?.loading && !hasBook) states.push({ kind: 'loading', message: '호가 불러오는 중…' });
  const result = combineBookAvailability(states);
  // A REST source owns its display failures. Live transport evidence is useful
  // in details, but a weekend reference book does not require a live connection.
  if (result && rest?.enabled && result.kind !== 'loading') {
    const related = (live?.issues ?? (live ? [live] : [])).filter(issue =>
      ['reference_limit', 'unconfigured', 'recovering', 'waiting_slot', 'display_delayed',
        'query_error', 'status_error', 'provider_error', 'storage_error'].includes(issue.kind));
    result.issues = [...(result.issues ?? []), ...related].filter((issue, index, all) =>
      all.findIndex(other => other.kind === issue.kind && other.retryTarget === issue.retryTarget) === index);
  }
  return result;
}
