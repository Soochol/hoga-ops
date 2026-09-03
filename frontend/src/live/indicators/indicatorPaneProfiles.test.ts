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
  peakWallPaneEnabled: false,
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

  it('picks the 8 pane toggles from an already-resolved slice (no merging)', () => {
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
      peakWallPaneHasContent: true,
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

  /**
   * 최대벽 pane 만 **저장값 그대로가 아니다** — 마스터 × 「그릴 것이 있는가」다.
   *
   * **막는 방향** 둘: (1) 곱이 사라져 마스터만 흘러가는 것 — 그러면 지표를 껐을 때
   * 계단 없는 빈 pane 이 남는다(2026-09-03 신고). (2) 곱이 **다른 pane 까지** 먹는 것 —
   * 최대벽 하나만 이 처리를 받는다.
   */
  it('최대벽 pane 만 「그릴 것이 있는가」와 곱해 넘긴다', () => {
    const armed = { ...RESOLVED_PREFS, peakWallPaneEnabled: true };
    const withContent = resolvePaneToggles({ indicators: armed, peakWallPaneHasContent: true });
    const noContent = resolvePaneToggles({ indicators: armed, peakWallPaneHasContent: false });
    expect(withContent.peakWallPaneEnabled).toBe(true);
    expect(noContent.peakWallPaneEnabled).toBe(false);
    // 마스터가 꺼져 있으면 내용과 무관하게 꺼짐(opt-in 은 그대로다).
    expect(resolvePaneToggles({
      indicators: RESOLVED_PREFS, peakWallPaneHasContent: true,
    }).peakWallPaneEnabled).toBe(false);
    // 다른 pane 은 이 곱을 타지 않는다.
    expect(noContent.volumeEnabled).toBe(true);
    expect(noContent.foreignNet).toBe(true);
  });
});
