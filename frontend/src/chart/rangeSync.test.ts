import { describe, expect, it } from 'vitest';
import type { SidebarCursorOrigin } from '../live/useLiveCursorStore';
import {
  MIN_FOLLOW_SPAN_BARS,
  canPublishRangeSync,
  centeredLogicalRange,
  isRangeSyncFollower,
  shouldFollowRange,
  zoomedSpan,
  type RangeSyncPublication,
} from './rangeSync';

function pub(over: Partial<SidebarCursorOrigin> = {}, seq = 1): RangeSyncPublication {
  return {
    fromMs: Date.UTC(2025, 5, 19, 0, 0),
    toMs: Date.UTC(2025, 5, 19, 6, 30),
    seq,
    origin: { windowId: 'minute-window', group: 1, code: '064350', timeframe: '3m', ...over },
  };
}

function follows(
  over: Partial<SidebarCursorOrigin> = {},
  allowCrossSymbol = false,
  myGroup: number | null = 1,
) {
  return shouldFollowRange({
    publication: pub(over),
    myWindowId: 'daily-window',
    myGroup,
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
      publication: null, myWindowId: 'daily-window', myGroup: 1, myCode: '064350',
      allowCrossSymbol: true,
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
/**
 * **줌 비율 옮기기**(`rangeSyncZoom`, 기본 끔).
 *
 * **막는 방향** 셋: ① 팬을 줌으로 오독하는 것(데드밴드) ② 분봉 배율을 그대로 곱해
 * 일봉이 3봉/12,000봉이 되는 것(클램프) ③ 천장·바닥에서 같은 값을 되쓰는 것.
 * **못 보는 것**: 이 함수는 비율만 본다 — "발행 창이 바뀌었는가" 는 호출부가 판단해
 * `prevPublishedSpanMs: null` 로 알려 준다(그 판정은 훅 테스트가 잰다).
 */
describe('zoomedSpan', () => {
  const base = { currentSpan: 200, candleCount: 400 };

  it('발행 폭이 절반이면 추종 폭도 절반 — 절대 폭이 아니라 **비율**을 옮긴다', () => {
    expect(zoomedSpan({ ...base, prevPublishedSpanMs: 20_000, nextPublishedSpanMs: 10_000 }))
      .toBe(100);
  });

  it('발행 폭이 2배면 추종 폭도 2배', () => {
    expect(zoomedSpan({ ...base, prevPublishedSpanMs: 10_000, nextPublishedSpanMs: 20_000 }))
      .toBe(400);
  });

  it('기준선이 없으면 건드리지 않는다 — 첫 발행·발행 창 교체', () => {
    expect(zoomedSpan({ ...base, prevPublishedSpanMs: null, nextPublishedSpanMs: 10_000 }))
      .toBeNull();
  });

  it('데드밴드 안이면 팬으로 본다 — 백필 재앵커가 폭을 조금 흔든다', () => {
    // 4% 변화. 부동소수 오차가 아니라 **백필 크기**의 흔들림을 흡수해야 한다.
    expect(zoomedSpan({ ...base, prevPublishedSpanMs: 10_000, nextPublishedSpanMs: 10_400 }))
      .toBeNull();
    // 6% 는 통과한다 — 문턱 바로 위.
    expect(zoomedSpan({ ...base, prevPublishedSpanMs: 10_000, nextPublishedSpanMs: 10_600 }))
      .toBe(212);
  });

  it('바닥은 최소 봉 수 — 분봉을 극단으로 확대해도 일봉은 읽힌다', () => {
    expect(zoomedSpan({ ...base, prevPublishedSpanMs: 10_000, nextPublishedSpanMs: 1 }))
      .toBe(MIN_FOLLOW_SPAN_BARS);
  });

  it('천장은 이 창의 캔들 수 — 그 이상은 여백만 늘린다', () => {
    expect(zoomedSpan({ ...base, prevPublishedSpanMs: 1, nextPublishedSpanMs: 10_000 }))
      .toBe(400);
  });

  it('클램프에 걸려 지금과 같아지면 null — 천장에서 1봉 진동을 남기지 않는다', () => {
    // 이미 천장(400)인데 더 축소(=폭 확대) 요청.
    expect(zoomedSpan({
      currentSpan: 400, candleCount: 400, prevPublishedSpanMs: 1, nextPublishedSpanMs: 10_000,
    })).toBeNull();
  });

  it('값이 유효하지 않으면 null', () => {
    expect(zoomedSpan({ ...base, prevPublishedSpanMs: 0, nextPublishedSpanMs: 10 })).toBeNull();
    expect(zoomedSpan({ ...base, currentSpan: 0, prevPublishedSpanMs: 10, nextPublishedSpanMs: 20 }))
      .toBeNull();
  });
});

/**
 * **우측 클램프**. 중앙 정렬이 자기 데이터 밖으로 밀고 나가면 화면 오른쪽 절반이
 * 빈 공간이 된다(2026-08-21 사용자 지적). 폭은 유지한 채 우측 끝에 붙인다.
 *
 * **막는 방향**: 마지막 캔들 + 표준 여백보다 오른쪽. **여는 방향**: 과거 쪽은 그대로
 * — 왼쪽 클램프는 없다(음수 `from` 이 곧 백필 트리거다).
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
