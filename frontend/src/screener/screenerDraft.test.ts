import { describe, it, expect, beforeEach } from 'vitest';
import {
  EMPTY_SCREENER_DRAFT,
  persistScreenerDraft,
  readScreenerDraft,
  type ScreenerDraft,
} from './screenerDraft';

const DRAFT: ScreenerDraft = {
  conditions: [{ id: 'c', type: 'new_high', params: { lookback: 200, period: 500 } }],
  universe: { markets: ['KOSPI'] },
  anchorId: 's1',
  anchorName: '급등주',
  dirty: true,
};

describe('screenerDraft', () => {
  beforeEach(() => localStorage.clear());

  it('returns the empty draft when storage is empty', () => {
    expect(readScreenerDraft()).toEqual(EMPTY_SCREENER_DRAFT);
  });

  it('round-trips a persisted draft', () => {
    persistScreenerDraft(DRAFT);
    expect(readScreenerDraft()).toEqual(DRAFT);
  });

  it('falls back to empty when conditions are not a leaf array', () => {
    localStorage.setItem('screenerDraft.v1', JSON.stringify({
      conditions: [{ id: 'c' }], // no string type
      universe: {},
      anchorId: null,
      anchorName: null,
      dirty: false,
    }));
    expect(readScreenerDraft()).toEqual(EMPTY_SCREENER_DRAFT);
  });

  it('coerces malformed anchor fields to null/false', () => {
    localStorage.setItem('screenerDraft.v1', JSON.stringify({
      conditions: [],
      universe: {},
      anchorId: 42,
      anchorName: {},
      dirty: 'yes',
    }));
    expect(readScreenerDraft()).toEqual(EMPTY_SCREENER_DRAFT);
  });
});
