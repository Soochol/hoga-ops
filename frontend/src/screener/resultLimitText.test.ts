import { describe, expect, it } from 'vitest';
import { resultLimitText } from './resultLimitText';

describe('스크리너 결과 상한 안내', () => {
  it('서버에서 초과를 확인한 경우에만 잘렸다고 단정한다', () => {
    expect(resultLimitText(1000, true)).toContain('거래대금 상위 1,000건만 표시');
    expect(resultLimitText(1000, true)).toContain('정렬은 표시된 결과 내에서 적용');
    expect(resultLimitText(1000, false)).toBeNull();
    expect(resultLimitText(2000, false)).toBeNull();
    expect(resultLimitText(10, true)).toContain('상위 10건');
  });

  it('구버전 응답은 상한 이상일 때 가능성으로 안내한다', () => {
    expect(resultLimitText(1000, undefined)).toContain('도달했을 수 있습니다');
    expect(resultLimitText(999, undefined)).toBeNull();
    expect(resultLimitText(0, undefined)).toBeNull();
  });
});
