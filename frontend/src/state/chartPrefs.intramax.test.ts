import { describe, it, expect } from 'vitest';
import { CHART_TOGGLES, DEFAULT_PREFS } from './chartPrefs';

describe('Intra-Bar Max 토글 등록', () => {
  const keys = ['quoteTotalsIntraMax', 'ratioIntraMax', 'askPeakIntraMax'] as const;

  it.each(keys)('%s: default false + category indicator-modal', (key) => {
    expect(DEFAULT_PREFS[key]).toBe(false);
    const entry = CHART_TOGGLES.find((t) => t.key === key);
    expect(entry).toBeDefined();
    expect((entry as { category?: string }).category).toBe('indicator-modal');
    expect((entry as { label: string }).label).toBe('분봉 내 최댓값 기준');
  });
});
