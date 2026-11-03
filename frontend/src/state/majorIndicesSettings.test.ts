import { describe, expect, it } from 'vitest';
import { normalizeMajorIndicesSettings } from './majorIndicesSettings';

describe('major index settings', () => {
  it.each([undefined, null, {}, { indices: [] }, { indices: ['INVALID'] }, { indices: 'KOSPI', showStock: 'false' }])(
    'defaults missing or invalid selections to all three indices (%j)', value => {
      expect(normalizeMajorIndicesSettings(value)).toEqual({ indices: ['KOSPI', 'KOSDAQ', 'KOSPI200'], showStock: true, showTooltip: false });
    });
  it.each([undefined, null, 'true', 1])('defaults missing or invalid tooltip settings to OFF (%j)', showTooltip => {
    expect(normalizeMajorIndicesSettings({ showTooltip }).showTooltip).toBe(false);
  });
  it.each([true, false])('preserves explicit tooltip visibility (%j)', showTooltip => {
    expect(normalizeMajorIndicesSettings({ showTooltip }).showTooltip).toBe(showTooltip);
  });
  it('keeps explicit stock OFF and deduplicates valid indices in display order', () => {
    expect(normalizeMajorIndicesSettings({ indices: ['KOSPI200', 'INVALID', 'KOSPI', 'KOSPI'], showStock: false }))
      .toEqual({ indices: ['KOSPI', 'KOSPI200'], showStock: false, showTooltip: false });
  });
});
