import { describe, it, expect } from 'vitest';
import { isRateLimitReason, summarizeWarnings } from './liveDataWarnings';

describe('isRateLimitReason', () => {
  it('rate-limit 계열만 true', () => {
    expect(isRateLimitReason('rate_limit_upstream')).toBe(true);
    expect(isRateLimitReason('rate_limit_aborted')).toBe(true);
  });
  it('비-rate-limit reason은 false', () => {
    expect(isRateLimitReason('api_error')).toBe(false);
    expect(isRateLimitReason('invariant_violation')).toBe(false);
    expect(isRateLimitReason('cache_write_failed')).toBe(false);
    expect(isRateLimitReason('')).toBe(false);
    expect(isRateLimitReason('unknown_future_reason')).toBe(false);
  });
});

describe('summarizeWarnings', () => {
  it('null/undefined/빈 배열 → 무경고', () => {
    expect(summarizeWarnings(null)).toEqual({ count: 0, hasRateLimit: false, firstMsg: null });
    expect(summarizeWarnings(undefined)).toEqual({ count: 0, hasRateLimit: false, firstMsg: null });
    expect(summarizeWarnings([])).toEqual({ count: 0, hasRateLimit: false, firstMsg: null });
  });
  it('rate-limit 경고 있으면 hasRateLimit=true, count 집계', () => {
    const w = [
      { reason: 'rate_limit_upstream', msg: 'x' },
      { reason: 'rate_limit_aborted', msg: 'y' },
    ];
    expect(summarizeWarnings(w)).toEqual({ count: 2, hasRateLimit: true, firstMsg: 'x' });
  });
  it('비-rate-limit 경고만 있으면 count>0 이지만 hasRateLimit=false', () => {
    const w = [
      { reason: 'api_error', msg: 'x' },
      { reason: 'invariant_violation', msg: 'y' },
      { reason: 'cache_write_failed', msg: 'z' },
    ];
    expect(summarizeWarnings(w)).toEqual({ count: 3, hasRateLimit: false, firstMsg: 'x' });
  });
  it('혼합: 하나라도 rate-limit이면 hasRateLimit=true', () => {
    const w = [
      { reason: 'cache_write_failed', msg: 'x' },
      { reason: 'rate_limit_upstream', msg: 'y' },
    ];
    expect(summarizeWarnings(w)).toEqual({ count: 2, hasRateLimit: true, firstMsg: 'x' });
  });
  it('firstMsg 는 msg 가 있는 첫 경고를 고른다 (msg 없는 앞 항목은 건너뛴다)', () => {
    // 백엔드 경고 중 일부는 msg 를 안 싣는다. 인덱스 0 만 보면 툴팁이 비어, 원인을
    // 노출하려던 목적이 조용히 사라진다.
    const w = [{ reason: 'api_error' }, { reason: 'api_error', msg: '8005' }];
    expect(summarizeWarnings(w).firstMsg).toBe('8005');
  });
  it('msg 가 하나도 없으면 firstMsg=null (툴팁 미부착)', () => {
    expect(summarizeWarnings([{ reason: 'api_error' }]).firstMsg).toBeNull();
  });
});
