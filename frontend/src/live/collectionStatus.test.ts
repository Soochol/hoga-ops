import { describe, it, expect } from 'vitest';
import { deriveCollectionStatus } from './collectionStatus';

describe('deriveCollectionStatus', () => {
  it('realtime: code가 live_set(WS)에 있으면', () => {
    expect(deriveCollectionStatus('005930', ['005930', '000660'], ['005930', '000660'], [])).toBe('realtime');
  });
  it('polling: live_set 밖이지만 지금 보는 종목(viewedCodes)이면', () => {
    expect(deriveCollectionStatus('035720', ['005930'], ['005930'], ['035720'])).toBe('polling');
  });
  it('realtime이 polling보다 우선: 관심종목을 보는 중이어도 realtime', () => {
    expect(deriveCollectionStatus('005930', ['005930'], ['005930'], ['005930'])).toBe('realtime');
  });
  it('uncollected: live_set 밖 + 안 보는 중 + watchlist에도 없음', () => {
    expect(deriveCollectionStatus('068270', ['005930'], ['005930'], [])).toBe('uncollected');
  });
  it('waiting_eod 폴백: watchlist엔 있으나 live_set 밖 + 안 보는 중 (관심종목 26 초과 케이스)', () => {
    expect(deriveCollectionStatus('068270', ['005930'], ['005930', '068270'], [])).toBe('waiting_eod');
  });
  it('uncollected: code가 null', () => {
    expect(deriveCollectionStatus(null, ['005930'], ['005930'], ['005930'])).toBe('uncollected');
  });
});
