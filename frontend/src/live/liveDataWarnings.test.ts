import { describe, it, expect } from 'vitest';
import { isRateLimitReason, summarizeWarnings } from './liveDataWarnings';

describe('isRateLimitReason', () => {
  it('rate-limit 계열만 true', () => {
    expect(isRateLimitReason('kis_rate_limit')).toBe(true);
    expect(isRateLimitReason('rate_limit_aborted')).toBe(true);
  });
  it('비-rate-limit reason은 false', () => {
    expect(isRateLimitReason('kis_api_error')).toBe(false);
    expect(isRateLimitReason('invariant_violation')).toBe(false);
    expect(isRateLimitReason('cache_write_failed')).toBe(false);
    expect(isRateLimitReason('')).toBe(false);
    expect(isRateLimitReason('unknown_future_reason')).toBe(false);
  });
});

describe('summarizeWarnings', () => {
  it('null/undefined/빈 배열 → 무경고', () => {
    expect(summarizeWarnings(null)).toEqual({ count: 0, hasRateLimit: false });
    expect(summarizeWarnings(undefined)).toEqual({ count: 0, hasRateLimit: false });
    expect(summarizeWarnings([])).toEqual({ count: 0, hasRateLimit: false });
  });
  it('rate-limit 경고 있으면 hasRateLimit=true, count 집계', () => {
    const w = [
      { reason: 'kis_rate_limit', msg: 'x' },
      { reason: 'rate_limit_aborted', msg: 'y' },
    ];
    expect(summarizeWarnings(w)).toEqual({ count: 2, hasRateLimit: true });
  });
  it('비-rate-limit 경고만 있으면 count>0 이지만 hasRateLimit=false', () => {
    const w = [
      { reason: 'kis_api_error', msg: 'x' },
      { reason: 'invariant_violation', msg: 'y' },
      { reason: 'cache_write_failed', msg: 'z' },
    ];
    expect(summarizeWarnings(w)).toEqual({ count: 3, hasRateLimit: false });
  });
  it('혼합: 하나라도 rate-limit이면 hasRateLimit=true', () => {
    const w = [
      { reason: 'cache_write_failed', msg: 'x' },
      { reason: 'kis_rate_limit', msg: 'y' },
    ];
    expect(summarizeWarnings(w)).toEqual({ count: 2, hasRateLimit: true });
  });
});
