import { describe, it, expect } from 'vitest';
import { isRateLimitWarning, summarizeWarnings } from './liveDataWarnings';

// ADR-0143 이관: 판정 축이 **사유 문자열에서 백엔드가 실은 `kind`** 로 바뀌었다.
// 그래서 픽스처도 wire 가 실제로 내려보내는 모양(`kind` 동반)을 쓴다 —
// 백엔드가 그 값을 싣는다는 것은 `tests/unit/live/test_data_warnings.py` 가 지킨다.
describe('isRateLimitWarning', () => {
  it('kind=rate_limit 만 true', () => {
    expect(isRateLimitWarning({ reason: 'rate_limit_upstream', kind: 'rate_limit' })).toBe(true);
    expect(isRateLimitWarning({ reason: 'rate_limit_aborted', kind: 'rate_limit' })).toBe(true);
  });

  it('다른 kind 는 false', () => {
    expect(isRateLimitWarning({ reason: 'api_error', kind: 'vendor_api' })).toBe(false);
    expect(isRateLimitWarning({ reason: 'invariant_violation', kind: 'data_quality' })).toBe(false);
  });

  // 큐 포화는 **우리 쪽**이라 "호출 한도" 문구가 거짓이 된다. 이관 전 사유 집합에도
  // 없었으므로 동작은 동등하다 — 백엔드 kind 를 `deferred` 로 고친 것이 그 동등성을
  // 만들었다(그대로 뒀다면 rate_limit 이라 여기서 true 가 됐다).
  it('capacity_overloaded(deferred) 는 rate-limit 이 아니다', () => {
    expect(isRateLimitWarning({ reason: 'capacity_overloaded', kind: 'deferred' })).toBe(false);
    expect(isRateLimitWarning({ reason: 'fetch_budget_exhausted', kind: 'deferred' })).toBe(false);
  });

  // 정보성 경고에는 kind 가 없고, 배포 직후 캐시(gcTime 2h)에는 kind 자체가 없는
  // 옛 응답이 남을 수 있다. 둘 다 "유량 아님" 으로 떨어져야 한다.
  it('kind 가 없으면 false', () => {
    expect(isRateLimitWarning({ reason: 'rest_bypassed', is_failure: false })).toBe(false);
    expect(isRateLimitWarning({ reason: 'rate_limit_upstream' })).toBe(false);
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
      { reason: 'rate_limit_upstream', kind: 'rate_limit' as const, msg: 'x' },
      { reason: 'rate_limit_aborted', kind: 'rate_limit' as const, msg: 'y' },
    ];
    expect(summarizeWarnings(w)).toEqual({ count: 2, hasRateLimit: true, firstMsg: 'x' });
  });

  it('비-rate-limit 경고만 있으면 count>0 이지만 hasRateLimit=false', () => {
    const w = [
      { reason: 'api_error', kind: 'vendor_api' as const, msg: 'x' },
      { reason: 'invariant_violation', kind: 'data_quality' as const, msg: 'y' },
      { reason: 'capacity_overloaded', kind: 'deferred' as const, msg: 'z' },
    ];
    expect(summarizeWarnings(w)).toEqual({ count: 3, hasRateLimit: false, firstMsg: 'x' });
  });

  it('혼합: 하나라도 rate-limit이면 hasRateLimit=true', () => {
    const w = [
      { reason: 'rest_bypassed', is_failure: false, msg: 'x' },
      { reason: 'rate_limit_upstream', kind: 'rate_limit' as const, msg: 'y' },
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
