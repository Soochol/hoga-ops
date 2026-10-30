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
const healthyStatus = (): LiveStatus => ({
  ...status({ view_subscriptions: rows('registered') }),
  provider_status: { observed_at_ms: nowMs, connection: 'connected', connected_accounts: 1,
    configured_accounts: 1, last_received_at_ms: nowMs, notice: null, notice_phase: null,
    notice_config_error: false, failures: [] },
});

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
  it('identifies the missing browser update only from recent matching server book receipts', () => {
    const stale = { ...input, bookMs: nowMs - 33_000 };
    expect(derive({ ...stale, status: status({ data_received_ms: { '005930:KRX:ob': nowMs - 100 } }) }))
      .toMatchObject({ kind: 'display_delayed', message: '화면 호가 갱신 지연' });
    for (const key of ['005930:NXT:ob', '000660:KRX:ob', '005930:KRX:trade']) {
      expect(derive({ ...stale, status: status({ data_received_ms: { [key]: nowMs } }) })?.kind).toBe('stale');
    }
    expect(derive({ ...stale, statusCurrent: false,
      status: status({ data_received_ms: { '005930:KRX:ob': nowMs } }) })?.kind).toBe('stale');
    expect(derive({ ...input, status: status({ view_subscriptions: rows('registered'),
      data_received_ms: { '005930:KRX:ob': nowMs } }) })?.kind).toBe('display_delayed');
  });
  it('separates an old event timestamp from recent browser receipts without asserting an outage', () => {
    expect(derive({ ...input, bookMs: nowMs - 33_000, browserReceivedMs: nowMs - 100 }))
      .toMatchObject({ kind: 'timestamp_old', message: '호가 시각 갱신 대기' });
    const unknown = derive({ ...input, bookMs: nowMs - 33_000, status: status() });
    expect(unknown?.kind).toBe('stale');
    expect(unknown?.message).not.toContain('수신 지연');
    expect(unknown?.detail).toContain('아직 구분할 수 없습니다');
    expect(unknown?.quiet).toBe(true);
  });
  it.each(['KRX', 'NXT', 'UN'] as const)('uses calm waiting copy for a healthy registered %s book', venue => {
    const healthy = healthyStatus();
    healthy.kiwoom!.view_subscriptions = [{ ...rows('registered')[0], venue }];
    expect(derive({ ...input, venue, bookMs: nowMs - 33_000, status: healthy }))
      .toMatchObject({ kind: 'stale', message: '호가 갱신 대기 중',
        detail: '새 호가가 수신되면 자동으로 갱신됩니다', lastBookMs: 67_000, action: 'status', quiet: true });
  });
  it.each(['rest', 'ws'] as const)('keeps diagnostic copy when a %s failure is observed', channel => {
    const healthy = healthyStatus();
    healthy.provider_status!.failures = [{ channel, kind: 'timeout', operation: 'REG',
      observed_at_ms: nowMs, code: null }];
    expect(derive({ ...input, bookMs: nowMs - 33_000, status: healthy }))
      .toMatchObject({ kind: 'provider_error', quiet: false });
  });
  it('requires current connection, error and matching registration evidence before softening copy', () => {
    const stale = { ...input, bookMs: nowMs - 33_000, status: healthyStatus() };
    const unknownFailures = healthyStatus();
    delete unknownFailures.provider_status!.failures;
    const partial = healthyStatus();
    partial.provider_status!.connection = 'partial';
    for (const candidate of [
      { ...stale, statusCurrent: false }, { ...stale, status: status() },
      { ...stale, status: unknownFailures }, { ...stale, venue: 'NXT' as const },
    ]) expect(derive(candidate)?.message).toBe('호가 갱신 확인 중');
    expect(derive({ ...stale, connected: false })?.kind).toBe('recovering');
    expect(derive({ ...stale, status: partial })?.kind).toBe('provider_error');
    expect(derive({ ...stale, error: new Error('series failed') })?.kind).toBe('query_error');
    stale.status.kiwoom!.data_received_ms = { '005930:KRX:ob': nowMs };
    expect(derive(stale)?.kind).toBe('display_delayed');
    expect(derive({ ...stale, browserReceivedMs: nowMs })?.kind).toBe('timestamp_old');
  });
  it('keeps uncertainty quiet but retains confirmed query and connection failures', () => {
    const stale = { ...input, bookMs: nowMs - 33_000 };
    expect(derive(stale)).toMatchObject({ kind: 'stale', quiet: true, lastBookMs: 67_000 });
    expect(derive({ ...stale, status: healthyStatus(), statusCurrent: false })?.quiet).toBe(true);
    expect(derive({ ...stale, browserReceivedMs: nowMs })).toMatchObject({ kind: 'timestamp_old', quiet: true });
    expect(derive({ ...stale, statusFailed: true })?.quiet).toBe(false);
    expect(derive({ ...stale, error: new Error('series failed') })?.quiet).toBe(false);
    const unavailable = healthyStatus();
    unavailable.provider_status!.connection = 'unavailable';
    expect(derive({ ...stale, status: unavailable })?.quiet).toBe(false);
    expect(derive({ ...stale, connected: false })).toMatchObject({ kind: 'recovering', quiet: false });
  });
});
