import { describe, expect, it } from 'vitest';
import { mergeLiveIndicatorPrefs } from '../../state/liveIndicatorsPersistence';
import {
  legacyPanePrefsFromIndicators,
  normalizePanePrefsByTimeframe,
  panePrefsForTimeframe,
  profileKeyForTimeframe,
  resolvePaneTogglesForTimeframe,
} from './indicatorPaneProfiles';

describe('indicatorPaneProfiles', () => {
  it('groups all minute timeframes into one minute profile', () => {
    expect(profileKeyForTimeframe('1m')).toBe('minute');
    expect(profileKeyForTimeframe('3m')).toBe('minute');
    expect(profileKeyForTimeframe('30m')).toBe('minute');
    expect(profileKeyForTimeframe('D')).toBe('D');
    expect(profileKeyForTimeframe('W')).toBe('W');
    expect(profileKeyForTimeframe('M')).toBe('M');
  });

  it('builds legacy pane prefs from flat persisted indicator fields', () => {
    const indicators = mergeLiveIndicatorPrefs({
      volumeEnabled: false,
      ratioEnabled: false,
      foreignNetEnabled: true,
    });

    expect(legacyPanePrefsFromIndicators(indicators)).toEqual({
      volumeEnabled: false,
      quoteTotalsEnabled: true,
      ratioEnabled: false,
      fillStrengthEnabled: true,
      programTradeEnabled: true,
      foreignNetEnabled: true,
      institutionNetEnabled: false,
    });
  });

  it('uses legacy fallback for profiles without overrides', () => {
    const indicators = mergeLiveIndicatorPrefs({
      volumeEnabled: false,
      ratioEnabled: false,
    });

    expect(panePrefsForTimeframe(indicators, 'D')).toMatchObject({
      volumeEnabled: false,
      ratioEnabled: false,
    });
  });

  it('applies only the selected profile override', () => {
    const indicators = {
      ...mergeLiveIndicatorPrefs({ ratioEnabled: true }),
      panePrefsByTimeframe: {
        D: { ratioEnabled: false },
      },
    };

    expect(panePrefsForTimeframe(indicators, 'D').ratioEnabled).toBe(false);
    expect(panePrefsForTimeframe(indicators, 'W').ratioEnabled).toBe(true);
    expect(panePrefsForTimeframe(indicators, '1m').ratioEnabled).toBe(true);
  });

  it('drops unknown profile keys and non-boolean pane values', () => {
    expect(normalizePanePrefsByTimeframe({
      D: { volumeEnabled: false, ratioEnabled: 'no' },
      '2m': { volumeEnabled: true },
      minute: { quoteTotalsEnabled: true, unknownEnabled: false },
    })).toEqual({
      D: { volumeEnabled: false },
      minute: { quoteTotalsEnabled: true },
    });
  });

  it('resolves pane toggles with data gate flags threaded through', () => {
    const indicators = {
      ...mergeLiveIndicatorPrefs({
        ratioEnabled: true,
      }),
      panePrefsByTimeframe: {
        D: {
          volumeEnabled: false,
          ratioEnabled: true,
          foreignNetEnabled: true,
        },
      },
    };

    expect(resolvePaneTogglesForTimeframe({
      indicators,
      timeframe: 'D',
      forceHogaPanes: true,
      hogaPanes: true,
    })).toMatchObject({
      volumeEnabled: false,
      ratioEnabled: true,
      foreignNet: true,
      institutionNet: false,
      forceHogaPanes: true,
      hogaPanes: true,
    });
  });
});
