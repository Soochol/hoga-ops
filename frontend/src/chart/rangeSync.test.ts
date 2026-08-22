import { describe, expect, it } from 'vitest';
import type { SidebarCursorOrigin } from '../live/useLiveCursorStore';
import {
  canPublishRangeSync,
  centeredLogicalRange,
  isRangeSyncFollower,
  resolveRangeSyncMode,
  replicatedRange,
  syncModeFor,
  type RangeSyncPublication,
} from './rangeSync';

/** 기본 스위치 — 「같은 봉 창끼리 완전 동기화」 켬(제품 기본값). */
const ON = { peer: true } as const;
/** peer 를 끈 상태 — cross 만 남는다. */
const OFF = { peer: false } as const;

function pub(over: Partial<SidebarCursorOrigin> = {}, seq = 1): RangeSyncPublication {
  return {
    fromMs: Date.UTC(2025, 5, 19, 0, 0),
    toMs: Date.UTC(2025, 5, 19, 6, 30),
    seq,
    origin: { windowId: 'minute-window', group: 1, code: '064350', timeframe: '3m', ...over },
  };
}

/** 일봉 소비 창 기준. 반환은 모드(또는 null) — 불리언이 아니다. */
function modeOf(
  over: Partial<SidebarCursorOrigin> = {},
  allowCrossSymbol = false,
  myGroup: number | null = 1,
  myTimeframe: 'D' | 'W' | 'M' | '1m' = 'D',
  switches: { peer: boolean } = ON,
) {
  return resolveRangeSyncMode({
    publication: pub(over),
    myWindowId: 'daily-window',
    myTimeframe,
    myGroup,
    myCode: '064350',
    allowCrossSymbol,
    switches,
  });
}

/** 기존 단언 문체 보존 — "따라가는가" 만 볼 때. */
const follows = (...a: Parameters<typeof modeOf>) => modeOf(...a) !== null;

/**
 * 발행·추종 집합. **크로스헤어와 달리 두 집합이 다르다** — 방향이 분봉→일봉 하나뿐이라
 * 분봉은 발행만, 일봉은 추종만 한다. 단일 슬롯 도둑 문제가 없는 이유는 발행자가
 * 분봉뿐이어서 아무도 남의 유효한 발행을 밀어내지 않기 때문이다.
 */
describe('모드 판정 · 발행/추종 집합', () => {
  it('분봉 → 일봉은 cross, 같은 캘린더 봉끼리는 peer', () => {
    expect(syncModeFor('D', '1m', ON)).toBe('cross');
    expect(syncModeFor('D', '240m', ON)).toBe('cross');
    expect(syncModeFor('D', 'D', ON)).toBe('peer');
    expect(syncModeFor('W', 'W', ON)).toBe('peer');
    expect(syncModeFor('M', 'M', ON)).toBe('peer');
  });

  it('분봉은 추종하지 않는다 — 발행만 한다(사용자 결정 2026-08-21)', () => {
    expect(syncModeFor('1m', '1m', ON)).toBeNull();
    expect(syncModeFor('5m', '1m', ON)).toBeNull();
    expect(syncModeFor('1m', 'D', ON)).toBeNull();
    for (const tf of ['1m', '5m', '240m'] as const) {
      expect(isRangeSyncFollower(tf, ON)).toBe(false);
    }
  });

  it('캘린더는 같은 봉끼리만 — 일↔주↔월은 통하지 않는다', () => {
    // 일봉 3개월을 월봉에 복제하면 캔들 3개가 되어 그 쌍에서 다시 쓸모가 없어진다.
    expect(syncModeFor('W', 'D', ON)).toBeNull();
    expect(syncModeFor('D', 'W', ON)).toBeNull();
    expect(syncModeFor('M', 'W', ON)).toBeNull();
    // W/M 은 분봉 발행도 받지 않는다(cross 는 일봉 전용).
    expect(syncModeFor('W', '1m', ON)).toBeNull();
    expect(syncModeFor('M', '1m', ON)).toBeNull();
  });

  /**
   * ⚠ 여기서 재는 것은 **「발행 집합 = 소비 집합」이 아니다.** 이 파일은 한때 그렇게
   * 적혀 있었고 그때는 두 집합이 우연히 같았다. 분봉이 발행만 하는 지금 구성에서
   * 그 등식은 틀렸다 — 진짜 불변식은 **내 발행을 받는 소비자가 있는가** 다.
   */
  it('발행 자격은 「받는 소비자가 있는가」에서 유도된다', () => {
    // 분봉: 스스로는 추종하지 않지만 일봉이 받으므로 발행 자격이 있다.
    expect(canPublishRangeSync('1m', ON)).toBe(true);
    expect(isRangeSyncFollower('1m', ON)).toBe(false);
    // 캘린더: 같은 봉 peer 가 받는다.
    for (const tf of ['D', 'W', 'M'] as const) {
      expect(canPublishRangeSync(tf, ON)).toBe(true);
      expect(isRangeSyncFollower(tf, ON)).toBe(true);
    }
  });
});

/**
 * peer 복제. **클램프하지 않는다** — 우측 클램프는 "자기 데이터 밖으로 밀지 않는다"
 * 는 규칙인데, 복제는 그 반대가 계약이다(상대가 보는 구간에 내 데이터가 없으면
 * 여백이 보이는 것이 정직하다).
 */
describe('replicatedRange', () => {
  it('발행 구간을 그대로 돌려준다', () => {
    expect(replicatedRange({ fromVirtualSec: 100, toVirtualSec: 200, current: null }))
      .toEqual({ from: 100, to: 200 });
  });

  it('이미 그 구간이면 null — 되쓰면 애니메이션이 재시작돼 떤다', () => {
    expect(replicatedRange({
      fromVirtualSec: 100, toVirtualSec: 200, current: { from: 100, to: 200 },
    })).toBeNull();
    // 1초 미만 차이도 무시(가상초는 반올림돼 들어온다).
    expect(replicatedRange({
      fromVirtualSec: 100, toVirtualSec: 200, current: { from: 100.4, to: 199.7 },
    })).toBeNull();
  });

  it('1초 이상 벌어지면 적용한다', () => {
    expect(replicatedRange({
      fromVirtualSec: 100, toVirtualSec: 200, current: { from: 102, to: 202 },
    })).toEqual({ from: 100, to: 200 });
  });

  it('구간이 뒤집혔거나 유한하지 않으면 null', () => {
    expect(replicatedRange({ fromVirtualSec: 200, toVirtualSec: 100, current: null })).toBeNull();
    expect(replicatedRange({ fromVirtualSec: NaN, toVirtualSec: 100, current: null })).toBeNull();
  });
});

/**
 * **「같은 봉 창끼리 완전 동기화」(`rangeSyncPeer`) 를 끄면** peer 가 **없는 모드**가
 * 된다 — 그러면 발행·소비 게이트가 거기서 유도되므로 일봉 창이 **발행도 멈춘다**.
 *
 * **이 가드가 막는 방향**: 아무도 안 받는 일봉 발행이 단일 슬롯을 훔쳐 분봉 발행을
 * 지우는 것. **못 보는 것**: 폭 합의가 함께 꺼지는가 — 그건 훅의 계약이라
 * `useRangeSync.test.tsx` 가 본다.
 */
describe('peer 스위치', () => {
  it('끄면 같은 봉끼리는 통하지 않는다 — cross 는 그대로', () => {
    expect(syncModeFor('D', 'D', OFF)).toBeNull();
    expect(syncModeFor('W', 'W', OFF)).toBeNull();
    expect(syncModeFor('M', 'M', OFF)).toBeNull();
    // 분봉 → 일봉은 이 토글과 무관하다.
    expect(syncModeFor('D', '1m', OFF)).toBe('cross');
  });

  it('끄면 일봉·주봉·월봉이 발행을 멈춘다 — 받는 소비자가 없어서', () => {
    for (const tf of ['D', 'W', 'M'] as const) {
      expect(canPublishRangeSync(tf, ON)).toBe(true);
      expect(canPublishRangeSync(tf, OFF)).toBe(false);
    }
    // 분봉 발행은 남는다 — 일봉이 cross 로 받는다.
    expect(canPublishRangeSync('1m', OFF)).toBe(true);
  });

  it('끄면 W/M 은 소비자도 안 단다 — 일봉만 cross 로 남는다', () => {
    expect(isRangeSyncFollower('D', OFF)).toBe(true);
    expect(isRangeSyncFollower('W', OFF)).toBe(false);
    expect(isRangeSyncFollower('M', OFF)).toBe(false);
  });

  it('판정에도 그대로 실린다', () => {
    expect(modeOf({ timeframe: 'D' }, false, 1, 'D', ON)).toBe('peer');
    expect(modeOf({ timeframe: 'D' }, false, 1, 'D', OFF)).toBeNull();
    expect(modeOf({}, false, 1, 'D', OFF)).toBe('cross');
  });
});

/**
 * **이 게이트가 막는 방향**: 자기 발행 되받기 · 비분봉 발행 · (토글이 꺼졌을 때) 다른
 * 종목. **못 보는 것**: 크로스헤어와 같은 code-null 구멍(양쪽 다 null 이면 통과).
 */
describe('shouldFollowRange', () => {
  it('발행이 없으면 따라가지 않는다', () => {
    expect(resolveRangeSyncMode({
      publication: null, myWindowId: 'daily-window', myTimeframe: 'D', myGroup: 1,
      myCode: '064350', allowCrossSymbol: true, switches: ON,
    })).toBeNull();
  });

  it('옆 분봉 창의 발행을 따라간다', () => {
    expect(follows()).toBe(true);
  });

  it('내가 발행자면 따라가지 않는다', () => {
    expect(follows({ windowId: 'daily-window' })).toBe(false);
  });

  it('일봉 발행은 peer 로 받고, 주/월 발행은 받지 않는다', () => {
    // **2026-08-21 번복**: 여기 「비분봉 발행은 따라가지 않는다 — 발행 자격은
    // 분봉뿐이다」가 있었다. 같은 캘린더 봉끼리의 peer 동기화가 생기며 뒤집혔다.
    // 일봉 소비 창 기준이므로 D 발행은 peer, W/M 발행은 봉이 달라 여전히 거절이다.
    expect(modeOf({ timeframe: 'D', windowId: 'other-daily' })).toBe('peer');
    expect(modeOf({ timeframe: 'W', windowId: 'other' })).toBeNull();
    expect(modeOf({ timeframe: 'M', windowId: 'other' })).toBeNull();
  });

  it('분봉 발행은 cross 로 받는다', () => {
    expect(modeOf()).toBe('cross');
  });

  it('창번호가 다르면 따라가지 않는다 — 세 동기화가 같은 범위 규칙을 쓴다', () => {
    // 사용자 결정 2026-08-21. 그룹 1 의 팬이 그룹 2 의 창을 움직이면 방해가 된다.
    expect(follows({ group: 2 })).toBe(false);
    // 종목 토글을 켜도 창번호는 열리지 않는다 — 축이 다르다.
    expect(follows({ group: 2 }, true)).toBe(false);
  });

  it('`/study` 처럼 양쪽이 번호 없음이면 통과한다', () => {
    expect(follows({ group: null }, false, null)).toBe(true);
  });

  it('한쪽만 번호가 없으면 막는다 — 관대한 비교를 쓰지 않는다', () => {
    expect(follows({ group: null }, true, 1)).toBe(false);
    expect(follows({ group: 1 }, true, null)).toBe(false);
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
describe('centeredLogicalRange — rightEdgeLimit', () => {
  const current = { from: 100, to: 200 }; // span 100

  it('중앙 정렬이 우측 끝을 넘으면 폭을 유지한 채 되민다', () => {
    // 중점 1,000 → 중앙 정렬이면 950~1,050. 끝이 1,000 이면 900~1,000.
    expect(centeredLogicalRange({
      fromIndex: 1_000, toIndex: 1_000, current, rightEdgeLimit: 1_000,
    })).toEqual({ from: 900, to: 1_000 });
  });

  it('넘지 않으면 중앙 정렬 그대로 — 과거 날짜는 영향 없다', () => {
    expect(centeredLogicalRange({
      fromIndex: 500, toIndex: 500, current, rightEdgeLimit: 1_000,
    })).toEqual({ from: 450, to: 550 });
  });

  it('줌으로 폭이 바뀌어도 같은 끝을 지킨다', () => {
    expect(centeredLogicalRange({
      fromIndex: 1_000, toIndex: 1_000, current, spanOverride: 40, rightEdgeLimit: 1_000,
    })).toEqual({ from: 960, to: 1_000 });
  });

  it('한계가 없으면(축에서 마지막 캔들을 못 찾음) 클램프하지 않는다', () => {
    expect(centeredLogicalRange({ fromIndex: 1_000, toIndex: 1_000, current }))
      .toEqual({ from: 950, to: 1_050 });
  });

  it('이미 끝에 붙어 있으면 null — 천장에서 되쓰면 떤다', () => {
    // 현재가 900~1,000 이고 중앙 정렬 결과도 같은 자리.
    expect(centeredLogicalRange({
      fromIndex: 1_000, toIndex: 1_000, current: { from: 900, to: 1_000 }, rightEdgeLimit: 1_000,
    })).toBeNull();
  });

  it('왼쪽은 클램프하지 않는다 — 음수 from 이 백필 트리거다', () => {
    expect(centeredLogicalRange({
      fromIndex: 0, toIndex: 0, current, rightEdgeLimit: 1_000,
    })).toEqual({ from: -50, to: 50 });
  });
});

describe('centeredLogicalRange — spanOverride', () => {
  const current = { from: 100, to: 200 };

  it('넘긴 폭으로 중앙 정렬한다 — 위치와 폭을 한 번에', () => {
    expect(centeredLogicalRange({ fromIndex: 140, toIndex: 160, current, spanOverride: 50 }))
      .toEqual({ from: 125, to: 175 });
  });

  it('제자리 줌도 적용한다 — 위치만 비교하면 줌 동기화가 통째로 죽는다', () => {
    // 중점 150 은 현재 중앙과 같다(위치 불변). 폭만 100 → 50 으로 바뀐다.
    const r = centeredLogicalRange({ fromIndex: 150, toIndex: 150, current, spanOverride: 50 });
    expect(r).toEqual({ from: 125, to: 175 });
  });

  it('위치도 폭도 그대로면 null', () => {
    expect(centeredLogicalRange({ fromIndex: 150, toIndex: 150, current, spanOverride: 100 }))
      .toBeNull();
  });
});

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
