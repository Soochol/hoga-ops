import { beforeEach, describe, expect, it } from 'vitest';
import {
  INDICATORS_WINDOW_MIGRATION_KEY,
  pickWindowIndicators,
  takeWindowIndicatorsForMigration,
} from './indicatorsWindowMigration';
import { STUDY_WORKSPACE_STORAGE_KEY, WORKSPACE_STORAGE_KEY } from './workspaceKeys';

/**
 * 창 소유 지표 → 전역 v2 1회 승격.
 *
 * 이 가드가 막는 실패는 **조용한 회귀**다: 읽기만 전역으로 되돌리면 그동안 아무도
 * 쓰지 않은 `live.indicators.v2` 가 실려 사용자의 현재 지표 구성이 옛 값이나
 * 공장값으로 바뀐다. 화면은 멀쩡히 그려지므로 "설정이 초기화됐다"로만 보인다.
 */

const IND = { paneOrder: [], paneStretch: {}, byTimeframe: { minute: { ratioEnabled: true } } };

function snapshot(windows: unknown[], zOrder: string[]) {
  return JSON.stringify({ schema_version: 2, windows, zOrder });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('pickWindowIndicators', () => {
  it('zOrder 최상단 차트 창의 지표를 고른다', () => {
    const picked = pickWindowIndicators({
      windows: [
        { id: 'a', kind: 'chart', chart: { indicators: { tag: 'a' } } },
        { id: 'b', kind: 'chart', chart: { indicators: { tag: 'b' } } },
      ],
      zOrder: ['a', 'b'], // 마지막이 포커스
    });
    expect(picked).toEqual({ tag: 'b' });
  });

  it('zOrder 가 손상돼도 차트 창이 있으면 잃지 않는다', () => {
    const picked = pickWindowIndicators({
      windows: [{ id: 'a', kind: 'chart', chart: { indicators: { tag: 'a' } } }],
      zOrder: ['없는id'],
    });
    expect(picked).toEqual({ tag: 'a' });
  });

  it('차트 창이 아니거나 지표가 없으면 null', () => {
    expect(pickWindowIndicators({ windows: [{ id: 'b', kind: 'book' }], zOrder: ['b'] })).toBeNull();
    expect(pickWindowIndicators({ windows: [{ id: 'a', kind: 'chart', chart: {} }], zOrder: ['a'] })).toBeNull();
    expect(pickWindowIndicators(null)).toBeNull();
    expect(pickWindowIndicators({ windows: 'nope' })).toBeNull();
  });
});

describe('takeWindowIndicatorsForMigration', () => {
  it('`/live` 탭 저장소를 가장 먼저 본다 — 그 탭이 실제로 보던 값이다', () => {
    sessionStorage.setItem(WORKSPACE_STORAGE_KEY, snapshot(
      [{ id: 'a', kind: 'chart', chart: { indicators: { tag: 'live-tab' } } }], ['a'],
    ));
    localStorage.setItem(WORKSPACE_STORAGE_KEY, snapshot(
      [{ id: 'a', kind: 'chart', chart: { indicators: { tag: 'live-shared' } } }], ['a'],
    ));
    expect(takeWindowIndicatorsForMigration()).toEqual({ tag: 'live-tab' });
  });

  it('`/live` 에 창 사본이 없으면 `/study` 로 내려간다', () => {
    localStorage.setItem(STUDY_WORKSPACE_STORAGE_KEY, snapshot(
      [{ id: 'a', kind: 'chart', chart: { indicators: IND } }], ['a'],
    ));
    expect(takeWindowIndicatorsForMigration()).toEqual(IND);
  });

  it('두 번째 호출부터는 null — 승격은 1회다', () => {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, snapshot(
      [{ id: 'a', kind: 'chart', chart: { indicators: IND } }], ['a'],
    ));
    expect(takeWindowIndicatorsForMigration()).toEqual(IND);
    // 마커가 섰으므로 옛 창 사본이 그대로 남아 있어도 다시 끌어올리지 않는다 —
    // 안 그러면 사용자가 새로 만진 값을 매 로드마다 옛 사본이 덮는다.
    expect(takeWindowIndicatorsForMigration()).toBeNull();
    expect(localStorage.getItem(INDICATORS_WINDOW_MIGRATION_KEY)).not.toBeNull();
  });

  it('창 사본이 아예 없어도 마커를 세운다(신규 사용자 — 매 로드 파싱 회피)', () => {
    expect(takeWindowIndicatorsForMigration()).toBeNull();
    expect(localStorage.getItem(INDICATORS_WINDOW_MIGRATION_KEY)).not.toBeNull();
  });
});
