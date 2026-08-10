import { describe, expect, it } from 'vitest';
import {
  normalizePanePrefsByTimeframe,
  pickPanePrefs,
  profileKeyForTimeframe,
  resolvePaneToggles,
} from './indicatorPaneProfiles';

const RESOLVED_PREFS = {
  volumeEnabled: true,
  quoteTotalsEnabled: false,
  ratioEnabled: false,
  fillStrengthEnabled: false,
  programTradeEnabled: false,
  foreignNetEnabled: true,
  institutionNetEnabled: false,
};

describe('indicatorPaneProfiles', () => {
  it('groups all minute timeframes into one minute profile', () => {
    expect(profileKeyForTimeframe('1m')).toBe('minute');
    expect(profileKeyForTimeframe('3m')).toBe('minute');
    expect(profileKeyForTimeframe('30m')).toBe('minute');
    // 분기가 `D/W/M 이 아니면 minute` 이라 새 분봉 tf 는 자동으로 여기 떨어진다 —
    // 폴스루가 아니라 설계(분봉은 지표 설정을 한 버킷에서 공유한다).
    expect(profileKeyForTimeframe('60m')).toBe('minute');
    expect(profileKeyForTimeframe('D')).toBe('D');
    expect(profileKeyForTimeframe('W')).toBe('W');
    expect(profileKeyForTimeframe('M')).toBe('M');
  });

  it('picks the 7 pane toggles from an already-resolved slice (no merging)', () => {
    expect(pickPanePrefs({ ...RESOLVED_PREFS, quoteTotalsEnabled: true })).toEqual({
      ...RESOLVED_PREFS,
      quoteTotalsEnabled: true,
    });
  });

  it('drops unknown profile keys and non-boolean pane values (v1 seed / legacy preset parsing)', () => {
    expect(normalizePanePrefsByTimeframe({
      D: { volumeEnabled: false, ratioEnabled: 'no' },
      '2m': { volumeEnabled: true },
      minute: { quoteTotalsEnabled: true, unknownEnabled: false },
    })).toEqual({
      D: { volumeEnabled: false },
      minute: { quoteTotalsEnabled: true },
    });
  });

  it('resolves pane toggles with data gate flags and overrides threaded through', () => {
    expect(resolvePaneToggles({
      indicators: RESOLVED_PREFS,
      forceHogaPanes: true,
      hogaPanes: true,
      override: { ratioEnabled: true },
    })).toMatchObject({
      volumeEnabled: true,
      ratioEnabled: true,
      quoteTotalsEnabled: false,
      foreignNet: true,
      institutionNet: false,
      forceHogaPanes: true,
      hogaPanes: true,
    });
  });
});
