import { describe, it, expect } from 'vitest';
import {
  PRESET_INDICATOR_FLAG_KEYS,
  normalizePresetEnableByTimeframe,
} from './presetFlags';

describe('PRESET_INDICATOR_FLAG_KEYS', () => {
  it('covers the 9 overlay enables + 7 pane toggles (16 enable keys)', () => {
    expect(PRESET_INDICATOR_FLAG_KEYS).toHaveLength(16);
    expect(PRESET_INDICATOR_FLAG_KEYS).toContain('movingAverageEnabled');
    expect(PRESET_INDICATOR_FLAG_KEYS).toContain('depthDeltaEnabled');
    expect(PRESET_INDICATOR_FLAG_KEYS).toContain('volumeEnabled');
    expect(PRESET_INDICATOR_FLAG_KEYS).toContain('foreignNetEnabled');
  });
});

describe('normalizePresetEnableByTimeframe', () => {
  it('keeps known profile/enable/boolean triples, drops the rest', () => {
    expect(normalizePresetEnableByTimeframe({
      minute: { askPeakEnabled: true, unknownKey: true, ratioEnabled: 'no' },
      D: { volumeEnabled: false },
      bogus: { askPeakEnabled: true },      // unknown profile → drop
      W: {},                                 // empty bucket → drop
    })).toEqual({
      minute: { askPeakEnabled: true },
      D: { volumeEnabled: false },
    });
  });

  it('returns {} for non-object input', () => {
    for (const raw of [undefined, null, 42, 'x', []]) {
      expect(normalizePresetEnableByTimeframe(raw)).toEqual({});
    }
  });
});
