import { describe, expect, it } from 'vitest';
import type { SidebarCursorOrigin } from '../live/useLiveCursorStore';
import {
  canPublishRangeSync,
  centeredLogicalRange,
  isRangeSyncFollower,
  shouldFollowRange,
  type RangeSyncPublication,
} from './rangeSync';

function pub(over: Partial<SidebarCursorOrigin> = {}, seq = 1): RangeSyncPublication {
  return {
    fromMs: Date.UTC(2025, 5, 19, 0, 0),
    toMs: Date.UTC(2025, 5, 19, 6, 30),
    seq,
    origin: { windowId: 'minute-window', group: null, code: '064350', timeframe: '3m', ...over },
  };
}

function follows(over: Partial<SidebarCursorOrigin> = {}, allowCrossSymbol = false) {
  return shouldFollowRange({
    publication: pub(over),
    myWindowId: 'daily-window',
    myCode: '064350',
    allowCrossSymbol,
  });
}

/**
 * 발행·추종 집합. **크로스헤어와 달리 두 집합이 다르다** — 방향이 분봉→일봉 하나뿐이라
 * 분봉은 발행만, 일봉은 추종만 한다. 단일 슬롯 도둑 문제가 없는 이유는 발행자가
 * 분봉뿐이어서 아무도 남의 유효한 발행을 밀어내지 않기 때문이다.
 */
describe('발행 ↔ 추종 집합', () => {
  it('분봉만 발행하고 D 만 추종한다', () => {
    for (const tf of ['1m', '5m', '240m'] as const) {
      expect(canPublishRangeSync(tf)).toBe(true);
      expect(isRangeSyncFollower(tf)).toBe(false);
    }
    expect(canPublishRangeSync('D')).toBe(false);
    expect(isRangeSyncFollower('D')).toBe(true);
    for (const tf of ['W', 'M'] as const) {
      expect(canPublishRangeSync(tf)).toBe(false);
      // W/M 은 한 캔들이 여러 날이라 "그 날이 어느 버킷인가" 가 포함 탐색이 된다.
      expect(isRangeSyncFollower(tf)).toBe(false);
    }
  });
});

/**
 * **이 게이트가 막는 방향**: 자기 발행 되받기 · 비분봉 발행 · (토글이 꺼졌을 때) 다른
 * 종목. **못 보는 것**: 크로스헤어와 같은 code-null 구멍(양쪽 다 null 이면 통과).
 */
describe('shouldFollowRange', () => {
  it('발행이 없으면 따라가지 않는다', () => {
    expect(shouldFollowRange({
      publication: null, myWindowId: 'daily-window', myCode: '064350', allowCrossSymbol: true,
    })).toBe(false);
  });

  it('옆 분봉 창의 발행을 따라간다', () => {
    expect(follows()).toBe(true);
  });

  it('내가 발행자면 따라가지 않는다', () => {
    expect(follows({ windowId: 'daily-window' })).toBe(false);
  });

  it('비분봉 발행은 따라가지 않는다 — 발행 자격은 분봉뿐이다', () => {
    expect(follows({ timeframe: 'D' })).toBe(false);
    expect(follows({ timeframe: 'W' })).toBe(false);
  });

  it('종목 축은 크로스헤어와 같은 토글이 정한다', () => {
    expect(follows({ code: '005930' }, false)).toBe(false);
    expect(follows({ code: '005930' }, true)).toBe(true);
  });
});

/**
 * 중앙 정렬 수식. **줌은 현재 값을 그대로 쓴다** — 분봉이 보는 폭(1~2일)을 일봉 축에
 * 맞추면 캔들 두 개짜리 화면이 된다.
 */
describe('centeredLogicalRange', () => {
  const current = { from: 100, to: 200 }; // span 100

  it('발행 구간의 중점을 화면 중앙에 둔다 — span 은 보존', () => {
    // 중점 50 → from = 50 - 50 = 0, to = 100. 폭은 그대로 100.
    expect(centeredLogicalRange({ fromIndex: 40, toIndex: 60, current }))
      .toEqual({ from: 0, to: 100 });
  });

  it('한 캔들만 보는 발행이면 그 캔들이 중앙에 온다', () => {
    expect(centeredLogicalRange({ fromIndex: 300, toIndex: 300, current }))
      .toEqual({ from: 250, to: 350 });
  });

  it('이미 중앙이면 null — 매 프레임 같은 값을 되쓰면 미세하게 떤다', () => {
    // 중점 150 → from = 100 = current.from. 차이 0.
    expect(centeredLogicalRange({ fromIndex: 140, toIndex: 160, current })).toBeNull();
    // 1 인덱스 미만 차이도 무시한다.
    expect(centeredLogicalRange({ fromIndex: 140.5, toIndex: 160.5, current })).toBeNull();
  });

  it('1 인덱스 이상 벌어지면 움직인다 — 문턱 바로 위', () => {
    expect(centeredLogicalRange({ fromIndex: 142, toIndex: 162, current }))
      .toEqual({ from: 102, to: 202 });
  });

  it('⚠ from 을 0 으로 클램프하지 않는다 — 음수가 곧 백필 트리거다', () => {
    // 로드된 가장 왼쪽 캔들보다 과거를 보는 상태. 여기서 잘라 내면 "그 기간을 보려고
    // 팬했는데 데이터가 안 불러와지는" 상태가 된다(useViewportBackfill 3b).
    const r = centeredLogicalRange({ fromIndex: 0, toIndex: 0, current });
    expect(r).toEqual({ from: -50, to: 50 });
  });

  it('span 이 0 이하거나 값이 유한하지 않으면 null', () => {
    expect(centeredLogicalRange({ fromIndex: 10, toIndex: 20, current: { from: 5, to: 5 } })).toBeNull();
    expect(centeredLogicalRange({ fromIndex: NaN, toIndex: 20, current })).toBeNull();
  });
});
