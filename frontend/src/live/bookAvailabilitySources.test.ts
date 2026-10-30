import { describe, expect, it, vi } from 'vitest';
import type { RestOrderbookResponse } from '../api/liveRestOrderbook';
import { resolveBookAvailability, type RestBookObservation } from './bookAvailabilitySources';

const saved: RestOrderbookResponse = { code: '005930', venue: 'KRX', source: 'stored', checked_at_ms: 100_000,
  fetched_at_ms: 50_000, refresh_failed: false, storage_failed: false,
  book: { ask: [{ price: 1000, qty: 10 }], bid: [], tot_ask: 10, tot_bid: 0, book_time: '16:57:40' } };
const input = { code: '005930', venue: 'KRX', hasBook: true, live: null };
const rest = (overrides: Partial<RestBookObservation> = {}): RestBookObservation => ({
  enabled: true, loading: false, isError: false, data: saved, retry: vi.fn(), ...overrides,
});

describe('selected orderbook source availability', () => {
  it('retains both REST refresh and storage failures with a single primary cause and no invented date', () => {
    const result = resolveBookAvailability({ ...input, rest: rest({ data: { ...saved, refresh_failed: true, storage_failed: true } }) });
    expect(result).toMatchObject({ kind: 'rest_error', message: '최신 호가 조회 실패', retryTarget: 'last_orderbook', lastBookClock: '16:57:40' });
    expect(result?.issues?.map(issue => issue.kind)).toEqual(['rest_error', 'storage_error']);
    expect(result?.lastBookMs).toBeUndefined();
  });
  it('shows a storage failure even when the displayed REST book is usable', () => {
    expect(resolveBookAvailability({ ...input, rest: rest({ data: { ...saved, storage_failed: true } }) }))
      .toMatchObject({ kind: 'storage_error', retryTarget: 'last_orderbook' });
    expect(resolveBookAvailability({ ...input, rest: rest() })).toBeNull();
  });
  it('distinguishes pending, empty, and failed reads without discarding a cached book on refetch failure', () => {
    const empty = { ...input, hasBook: false };
    expect(resolveBookAvailability({ ...empty, rest: rest({ data: undefined, loading: true }) }))
      .toMatchObject({ kind: 'loading', message: '마지막 호가 불러오는 중…' });
    expect(resolveBookAvailability({ ...empty, rest: rest({ data: undefined }) }))
      .toMatchObject({ kind: 'empty', retryTarget: 'last_orderbook' });
    expect(resolveBookAvailability({ ...empty, rest: rest({ data: undefined, isError: true }) }))
      .toMatchObject({ kind: 'rest_error', message: '마지막 호가 조회 실패' });
    expect(resolveBookAvailability({ ...input, rest: rest({ isError: true }) }))
      .toMatchObject({ kind: 'rest_error', message: '최신 호가 조회 실패', lastBookClock: '16:57:40' });
  });
  it.each([{ ...saved, code: '000660' }, { ...saved, venue: 'NXT' as const }])('ignores flags and clocks from a different subject', data => {
    expect(resolveBookAvailability({ ...input, hasBook: false, rest: rest({ data: { ...data, refresh_failed: true, storage_failed: true } }) }))
      .toMatchObject({ kind: 'empty', lastBookClock: undefined });
  });
  it('stops reporting REST errors once a live source takes over', () => {
    expect(resolveBookAvailability({ ...input, rest: rest({ enabled: false, isError: true,
      data: { ...saved, refresh_failed: true, storage_failed: true } }) })).toBeNull();
  });
  it('suppresses routine live waiting beside a REST book, retaining confirmed failures for details', () => {
    expect(resolveBookAvailability({ ...input, live: { kind: 'awaiting_book', message: '첫 호가 수신 대기 중' }, rest: rest() })).toBeNull();
    const result = resolveBookAvailability({ ...input, live: { kind: 'recovering', message: '실시간 연결 복구 중', action: 'status' },
      rest: rest({ isError: true }) });
    expect(result?.kind).toBe('rest_error');
    expect(result?.issues?.map(issue => issue.kind)).toEqual(['rest_error', 'recovering']);
  });
  it.each(['single_price', 'saved_regular'] as const)('routes selected %s failures separately from live data', target => {
    const result = resolveBookAvailability({ ...input, query: { target, loading: false, error: true, retry: vi.fn() } });
    expect(result?.retryTarget).toBe(target);
    expect(result?.detail).toContain('기존 호가를 유지');
  });
});
