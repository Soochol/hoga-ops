import { describe, it, expect } from 'vitest';

import { brokerSeriesFreshness } from './brokerSeries';

describe('brokerSeriesFreshness', () => {
  it('today-inclusive(date >= todayKst) → 60s refetch (꼬리 전진)', () => {
    expect(brokerSeriesFreshness('20260608', '20260608')).toEqual({
      staleTime: 60_000,
      refetchInterval: 60_000,
    });
  });
  it('past(date < todayKst) → no refetch (불변 과거)', () => {
    expect(brokerSeriesFreshness('20260601', '20260608')).toEqual({
      staleTime: Infinity,
      refetchInterval: false,
    });
  });
  it('todayKst/date 미상 → 안전하게 no refetch', () => {
    expect(brokerSeriesFreshness(null, '20260608')).toEqual({
      staleTime: Infinity,
      refetchInterval: false,
    });
    expect(brokerSeriesFreshness('20260608', null)).toEqual({
      staleTime: Infinity,
      refetchInterval: false,
    });
  });
});
