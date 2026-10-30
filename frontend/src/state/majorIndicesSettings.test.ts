import { describe, expect, it } from 'vitest';
import { normalizeMajorIndicesSettings } from './majorIndicesSettings';

describe('major index settings', () => {
  it.each([undefined, null, {}, { indices: [] }, { indices: ['INVALID'] }, { indices: 'KOSPI', showStock: 'false' }])(
    'defaults missing or invalid selections to all three indices (%j)', value => {
      expect(normalizeMajorIndicesSettings(value)).toEqual({ indices: ['KOSPI', 'KOSDAQ', 'KOSPI200'], showStock: true });
    });
  it('keeps explicit stock OFF and deduplicates valid indices in display order', () => {
    expect(normalizeMajorIndicesSettings({ indices: ['KOSPI200', 'INVALID', 'KOSPI', 'KOSPI'], showStock: false }))
      .toEqual({ indices: ['KOSPI', 'KOSPI200'], showStock: false });
  });
});
