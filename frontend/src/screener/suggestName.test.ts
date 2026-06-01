import { describe, it, expect } from 'vitest';
import { suggestSaveName } from './suggestName';

describe('suggestSaveName', () => {
  it('returns 새조건1 when there are no names', () => {
    expect(suggestSaveName([])).toBe('새조건1');
  });
  it('ignores unrelated names', () => {
    expect(suggestSaveName(['급등주', '눌림목'])).toBe('새조건1');
  });
  it('fills the smallest gap in 새조건N', () => {
    expect(suggestSaveName(['새조건1', '새조건3'])).toBe('새조건2');
  });
  it('continues past a contiguous run', () => {
    expect(suggestSaveName(['새조건1', '새조건2'])).toBe('새조건3');
  });
});
