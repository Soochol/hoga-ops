import { describe, it, expect, beforeEach } from 'vitest';
import { useCaptureTimings } from './useCaptureTimings';
import type { TimingSummary } from '../../api/types';

function makeSummary(overrides: Partial<TimingSummary> = {}): TimingSummary {
  return {
    code: '005930',
    date: '20250520',
    started_at_kst: '2026-05-27T14:32:18+09:00',
    ended_at_kst: '2026-05-27T14:33:02+09:00',
    total_ms: 1000,
    phase_totals_ms: {
      http_fetch_ms: 800,
      parse_ms: 100,
      disk_write_ms: 50,
      rate_limit_ms: 50,
      backoff_ms: 0,
      cookie_pause_ms: 0,
      other_ms: 0,
    },
    phase_percentages: {
      http_fetch: 80, parse: 10, disk_write: 5, rate_limit: 5,
      backoff: 0, cookie_pause: 0, other: 0,
    },
    unaccounted_ms: 0,
    page_count: 5,
    event_count: 100,
    error_counts: {},
    env: {
      rate_limit_s: 0.05, max_concurrent: 3, page_step_ms_initial: 60000,
      hoga_version: '0.1.0', git_sha: null,
    },
    ...overrides,
  };
}

describe('useCaptureTimings', () => {
  beforeEach(() => {
    useCaptureTimings.setState({ timings: {} });
  });

  it('upserts a timing by id', () => {
    const s = makeSummary();
    useCaptureTimings.getState().upsert('005930:20250520', s);
    expect(useCaptureTimings.getState().timings['005930:20250520']).toEqual(s);
  });

  it('replaces on re-emit (dedup by id)', () => {
    const a = makeSummary({ event_count: 100 });
    const b = makeSummary({ event_count: 200 });
    useCaptureTimings.getState().upsert('005930:20250520', a);
    useCaptureTimings.getState().upsert('005930:20250520', b);
    expect(useCaptureTimings.getState().timings['005930:20250520'].event_count).toBe(200);
  });

  it('reads by id helper returns undefined for unknown', () => {
    expect(useCaptureTimings.getState().get('999999:20990101')).toBeUndefined();
  });
});
