import { describe, expect, it } from 'vitest';
import type { LiveStatus, KiwoomStatus } from '../api/liveStatus';
import { deriveOrderbookAvailability as derive } from './orderbookAvailability';

const nowMs = 100_000;
const input = { code: '005930', venue: 'KRX' as const, nowMs, loading: false, error: null,
  statusCurrent: true, connected: true, referenceLimited: false };
const status = (overrides: Partial<KiwoomStatus> = {}): LiveStatus => ({
  kiwoom: { enabled: true, accounts_configured: 1, connected_accounts: 1, subscribed_count: 0,
    last_tick_ms: null, accounts: [], connection_allowed: true, ...overrides },
} as LiveStatus);
const rows = (phase: 'registered' | 'waiting_slot' | 'registering' | 'waiting_connection') =>
  [{ code: '005930', venue: 'KRX', phase, connection_generation: 1 }];

describe('orderbook availability', () => {
  it.each([
    ['registered', 'awaiting_book'], ['waiting_slot', 'waiting_slot'],
    ['registering', 'registering'], ['waiting_connection', 'recovering'],
  ] as const)('maps actual %s state to %s', (phase, kind) => {
    expect(derive({ ...input, status: status({ view_subscriptions: rows(phase) }) })?.kind).toBe(kind);
  });
  it('keeps waiting for the first book when only trades arrived', () => {
    const state = derive({ ...input, status: status({ view_subscriptions: rows('registered'),
      data_received_ms: { '005930:KRX:trade': nowMs } }) });
    expect(state?.message).toBe('첫 호가 수신 대기 중');
  });
  it('does not borrow another code or venue registration', () => {
    expect(derive({ ...input, venue: 'NXT', status: status({ view_subscriptions: rows('registered'),
      ready_registrations: ['005930', '000660_NX'], data_received_ms: { '005930:KRX:ob': nowMs } }) })?.kind).toBe('registering');
  });
  it('prefers an actual fresh book to slow status and failed initial metadata', () => {
    expect(derive({ ...input, loading: true, error: new Error('metadata'), bookMs: nowMs - 100,
      status: status({ view_subscriptions: rows('waiting_slot') }) })).toBeNull();
  });
  it('retains an old book with its timestamp while reporting recovery', () => {
    expect(derive({ ...input, bookMs: nowMs - 31_000, connected: false })).toMatchObject({ kind: 'recovering', lastBookMs: 69_000 });
  });
  it('does not infer market closure from an old or absent book', () => {
    expect(derive({ ...input, bookMs: 10 })?.kind).toBe('stale');
    expect(derive({ ...input, status: status({ connection_allowed: false }) })?.kind).toBe('closed');
    expect(derive({ ...input, statusCurrent: false, status: status({ connection_allowed: false }) })?.kind).toBe('registering');
  });
  it('offers a retry on initial query failure and handles unknown server status', () => {
    expect(derive({ ...input, error: new Error('query'), connected: false })).toMatchObject({ kind: 'query_error', action: 'retry' });
    expect(derive({ ...input, loading: true })?.kind).toBe('loading');
    expect(derive(input)?.kind).toBe('registering');
  });
  it('makes application reference limits persistent and distinct from vendor slots', () => {
    expect(derive({ ...input, referenceLimited: true })?.kind).toBe('reference_limit');
  });
});
