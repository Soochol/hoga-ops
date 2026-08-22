import { describe, expect, it } from 'vitest';
import type { SidebarCursorOrigin } from '../live/useLiveCursorStore';
import {
  acceptsRangeOrigin,
  canPublishRangeSync,
  isRangeSyncFollower,
  replicatedLogicalRange,
  shouldFollowRange,
  type RangeSyncPublication,
} from './rangeSync';

function pub(over: Partial<SidebarCursorOrigin> = {}, seq = 1): RangeSyncPublication {
  return {
    fromMs: Date.UTC(2025, 5, 19, 0, 0),
    toMs: Date.UTC(2025, 5, 19, 6, 30),
    seq,
    origin: { windowId: 'other-daily', group: 1, code: '064350', timeframe: 'D', ...over },
  };
}

/** 일봉 소비 창 기준. */
function follows(
  over: Partial<SidebarCursorOrigin> = {},
  allowCrossSymbol = false,
  myGroup: number | null = 1,
  myTimeframe: 'D' | 'W' | 'M' | '1m' = 'D',
) {
  return shouldFollowRange({
    publication: pub(over),
    myWindowId: 'daily-window',
    myTimeframe,
    myGroup,
    myCode: '064350',
    allowCrossSymbol,
  });
}

/**
 * 참여 집합. **발행 집합 = 소비 집합**이 지금은 성립하지만(양쪽 다 캘린더 봉) 그건
 * 결과이지 정의가 아니다 — 분봉이 발행만 하던 시절에는 달랐다. 그래서 술어를
 * `acceptsRangeOrigin` 에서 유도하고, 여기서는 그 유도의 결과를 잰다.
 */
describe('참여 집합', () => {
  it('같은 캘린더 봉끼리만 통한다', () => {
    expect(acceptsRangeOrigin('D', 'D')).toBe(true);
    expect(acceptsRangeOrigin('W', 'W')).toBe(true);
    expect(acceptsRangeOrigin('M', 'M')).toBe(true);
  });

  it('**분봉은 양쪽 다 아니다**(사용자 결정 2026-08-22)', () => {
    // 분봉을 밀어도 일봉이 움직이지 않는다 — cross 모드를 걷어낸 것이 이 줄이다.
    expect(acceptsRangeOrigin('D', '1m')).toBe(false);
    expect(acceptsRangeOrigin('D', '240m')).toBe(false);
    // 분봉은 받지도 발행하지도 않는다.
    expect(acceptsRangeOrigin('1m', '1m')).toBe(false);
    expect(acceptsRangeOrigin('1m', 'D')).toBe(false);
    for (const tf of ['1m', '5m', '240m'] as const) {
      expect(isRangeSyncFollower(tf)).toBe(false);
      expect(canPublishRangeSync(tf)).toBe(false);
    }
  });

  it('일↔주↔월은 통하지 않는다', () => {
    // 일봉 3개월을 월봉에 복제하면 캔들 3개가 되어 그 쌍에서 다시 쓸모가 없어진다.
    expect(acceptsRangeOrigin('W', 'D')).toBe(false);
    expect(acceptsRangeOrigin('D', 'W')).toBe(false);
    expect(acceptsRangeOrigin('M', 'W')).toBe(false);
  });

  it('발행 자격은 「받는 소비자가 있는가」에서 유도된다', () => {
    for (const tf of ['D', 'W', 'M'] as const) {
      expect(canPublishRangeSync(tf)).toBe(true);
      expect(isRangeSyncFollower(tf)).toBe(true);
    }
  });
});

/**
 * peer 복제. **클램프하지 않는다** — 우측 클램프는 "자기 데이터 밖으로 밀지 않는다"
 * 는 규칙인데, 복제는 그 반대가 계약이다(상대가 보는 구간에 내 데이터가 없으면
 * 여백이 보이는 것이 정직하다).
 */
describe('replicatedLogicalRange', () => {
  /** 기준 캔들이 내 축에서 200 번 인덱스인 창. */
  const anchorIndex = 200;
  /** 발행 창: 기준 캔들 왼쪽 120봉 ~ 오른쪽 30봉(= 여백 30봉을 보고 있다). */
  const bars = { anchorMs: 1_700_000_000_000, fromBars: -120, toBars: 30 };

  it('기준점을 내 축에서 찾아 봉 오프셋을 그대로 옮긴다 — **여백까지**', () => {
    expect(replicatedLogicalRange({ anchorIndex, bars, current: null }))
      .toEqual({ from: 80, to: 230 });
  });

  it('기준 인덱스가 다르면 결과도 옮겨간다 — 로드 이력이 달라도 같은 화면', () => {
    // 백필이 70봉 더 된 창은 같은 날짜가 270 번이다. 오프셋은 불변이라 화면은 같다.
    expect(replicatedLogicalRange({ anchorIndex: 270, bars, current: null }))
      .toEqual({ from: 150, to: 300 });
  });

  it('왼쪽으로 음수도 그대로 나간다 — 그게 백필 트리거다', () => {
    expect(replicatedLogicalRange({
      anchorIndex: 10, bars: { ...bars, fromBars: -120, toBars: -20 }, current: null,
    })).toEqual({ from: -110, to: -10 });
  });

  it('이미 그 구간이면 null — 되쓰면 애니메이션이 재시작돼 떤다', () => {
    expect(replicatedLogicalRange({ anchorIndex, bars, current: { from: 80, to: 230 } }))
      .toBeNull();
    // 한 봉 미만 차이도 무시.
    expect(replicatedLogicalRange({ anchorIndex, bars, current: { from: 80.4, to: 229.7 } }))
      .toBeNull();
  });

  it('한 봉 이상 벌어지면 적용한다', () => {
    expect(replicatedLogicalRange({ anchorIndex, bars, current: { from: 82, to: 232 } }))
      .toEqual({ from: 80, to: 230 });
  });

  it('구간이 뒤집혔거나 유한하지 않으면 null', () => {
    expect(replicatedLogicalRange({
      anchorIndex, bars: { ...bars, fromBars: 30, toBars: -120 }, current: null,
    })).toBeNull();
    expect(replicatedLogicalRange({ anchorIndex: NaN, bars, current: null })).toBeNull();
  });
});


/**
 * **이 게이트가 막는 방향**: 자기 발행 되받기 · 다른 봉의 발행 · 다른 창번호 ·
 * (토글이 꺼졌을 때) 다른 종목.
 * **못 보는 것**: 크로스헤어와 같은 code-null 구멍(양쪽 다 null 이면 통과).
 */
describe('shouldFollowRange', () => {
  it('발행이 없으면 따라가지 않는다', () => {
    expect(shouldFollowRange({
      publication: null, myWindowId: 'daily-window', myTimeframe: 'D', myGroup: 1,
      myCode: '064350', allowCrossSymbol: true,
    })).toBe(false);
  });

  it('옆 일봉 창의 발행을 따라간다', () => {
    expect(follows()).toBe(true);
  });

  it('내가 발행자면 따라가지 않는다', () => {
    expect(follows({ windowId: 'daily-window' })).toBe(false);
  });

  it('다른 봉의 발행은 받지 않는다 — 주/월도, **분봉도**', () => {
    // **2026-08-22 번복**: 여기 「분봉 발행은 cross 로 받는다」가 있었다. 분봉을
    // 밀어도 일봉이 움직이지 않게 하려고 cross 를 걷어내면서 뒤집혔다.
    expect(follows({ timeframe: 'W', windowId: 'other' })).toBe(false);
    expect(follows({ timeframe: 'M', windowId: 'other' })).toBe(false);
    expect(follows({ timeframe: '1m', windowId: 'minute-window' })).toBe(false);
    expect(follows({ timeframe: '240m', windowId: 'minute-window' })).toBe(false);
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



