import { describe, expect, it } from 'vitest';
import { resolveDayBoundaryTicks, sameDayBoundaryTicks } from './dayBoundaryTicks';
import { createVirtualAxis } from '../util/virtualAxis';
import type { Candle } from '../api/types';

const DAY_MS = 86_400_000;
const SESSION_MS = 23_400_000; // 09:00~15:30
const D0_OPEN = 1_780_012_800_000; // 20260529 09:00 KST

function seg(date: string, dayOffset: number) {
  return {
    date,
    sessionOpenMs: D0_OPEN + dayOffset * DAY_MS,
    sessionCloseMs: D0_OPEN + dayOffset * DAY_MS + SESSION_MS,
  };
}

function candle(ts: number): Candle {
  return { ts_ms: ts, open: 1, close: 1, high: 1, low: 1, vol_a: 0, vol_b: 0 };
}

/** 세션 하나를 3분봉으로 채운다. `skipMinutes` 만큼 **개장 뒤에** 시작한다. */
function session(openMs: number, skipMinutes = 0, count = 5): Candle[] {
  const start = openMs + skipMinutes * 60_000;
  return Array.from({ length: count }, (_, i) => candle(start + i * 180_000));
}

describe('resolveDayBoundaryTicks', () => {
  it('첫 캔들이 개장 정각이면 경계는 개장 시각에 선다', () => {
    const axis = createVirtualAxis([seg('20260529', 0), seg('20260602', 4)], D0_OPEN);
    const candles = [
      ...session(axis.segments[0].sessionOpenMs),
      ...session(axis.segments[1].sessionOpenMs),
    ];

    expect(resolveDayBoundaryTicks(candles, axis)).toEqual([
      { date: '20260602', virtualMs: axis.segments[1].virtualStart },
    ]);
  });

  // 이 리포가 실제로 겪은 결손 — 005380 3분봉의 20260602 는 첫 캔들이 09:12 라
  // 경계를 개장 정각으로 잡으면 lwc 축에 그 시각이 없어 좌표가 null 이 되고
  // 구분선이 통째로 사라졌다. **값으로** 재는 이유: 개장 정각을 그대로 돌려주는
  // 회귀가 들어와도 개수 단언은 초록으로 통과한다.
  it('첫 캔들이 늦으면 경계도 그 캔들로 밀린다 (20260602 = 개장 +12분)', () => {
    const axis = createVirtualAxis([seg('20260529', 0), seg('20260602', 4)], D0_OPEN);
    const candles = [
      ...session(axis.segments[0].sessionOpenMs),
      ...session(axis.segments[1].sessionOpenMs, 12),
    ];

    const ticks = resolveDayBoundaryTicks(candles, axis);
    expect(ticks).toHaveLength(1);
    expect(ticks[0].virtualMs).toBe(axis.segments[1].virtualStart + 12 * 60_000);
    // 개장 정각(= 종전 동작)이 아니어야 한다.
    expect(ticks[0].virtualMs).not.toBe(axis.segments[1].virtualStart);
  });

  it('경계 시각은 캔들 projector 가 setData 에 넣는 시각과 정확히 일치한다', () => {
    const axis = createVirtualAxis([seg('20260529', 0), seg('20260602', 4)], D0_OPEN);
    const late = session(axis.segments[1].sessionOpenMs, 12);
    const candles = [...session(axis.segments[0].sessionOpenMs), ...late];

    const ticks = resolveDayBoundaryTicks(candles, axis);
    // projector 와 같은 술어·같은 산식으로 얻은 값이어야 좌표가 나온다.
    expect(ticks[0].virtualMs).toBe(axis.classifyAndProject(late[0].ts_ms).virtual);
  });

  it('장외 캔들은 건너뛰고 첫 세션 내 캔들을 쓴다', () => {
    const axis = createVirtualAxis([seg('20260529', 0), seg('20260602', 4)], D0_OPEN);
    const open1 = axis.segments[1].sessionOpenMs;
    const candles = [
      ...session(axis.segments[0].sessionOpenMs),
      // 개장 1분 전 — `contained` 가 false 라 projector 가 버리는 캔들.
      candle(open1 - 60_000),
      ...session(open1, 3),
    ];

    const ticks = resolveDayBoundaryTicks(candles, axis);
    expect(ticks[0].virtualMs).toBe(axis.segments[1].virtualStart + 3 * 60_000);
  });

  it('캔들이 하나도 없는 세그먼트는 경계를 내지 않는다', () => {
    const axis = createVirtualAxis(
      [seg('20260529', 0), seg('20260602', 4), seg('20260604', 6)],
      D0_OPEN,
    );
    const candles = [
      ...session(axis.segments[0].sessionOpenMs),
      // 20260602 는 비어 있다.
      ...session(axis.segments[2].sessionOpenMs),
    ];

    expect(resolveDayBoundaryTicks(candles, axis).map((t) => t.date)).toEqual(['20260604']);
  });

  it('segments[0] 은 경계를 열지 않는다', () => {
    const axis = createVirtualAxis([seg('20260529', 0)], D0_OPEN);
    expect(resolveDayBoundaryTicks(session(axis.segments[0].sessionOpenMs), axis)).toEqual([]);
  });

  it('캔들이 없으면 빈 결과', () => {
    const axis = createVirtualAxis([seg('20260529', 0), seg('20260602', 4)], D0_OPEN);
    expect(resolveDayBoundaryTicks([], axis)).toEqual([]);
  });
});

describe('sameDayBoundaryTicks', () => {
  it('값이 같으면 true — 참조가 달라도', () => {
    expect(
      sameDayBoundaryTicks(
        [{ date: '20260602', virtualMs: 100 }],
        [{ date: '20260602', virtualMs: 100 }],
      ),
    ).toBe(true);
  });

  it('시각이 다르면 false', () => {
    expect(
      sameDayBoundaryTicks(
        [{ date: '20260602', virtualMs: 100 }],
        [{ date: '20260602', virtualMs: 101 }],
      ),
    ).toBe(false);
  });

  it('개수가 다르면 false', () => {
    expect(sameDayBoundaryTicks([], [{ date: '20260602', virtualMs: 100 }])).toBe(false);
  });

  // 오늘 캔들이 붙어도 각 세션의 첫 캔들은 안 바뀐다 — 그래서 SSE 틱마다 새
  // 배열이 와도 이전 참조를 유지할 수 있다는 것이 오버레이 memo 의 전제다.
  it('오늘 캔들이 append 돼도 경계는 그대로다', () => {
    const axis = createVirtualAxis([seg('20260529', 0), seg('20260602', 4)], D0_OPEN);
    const base = [
      ...session(axis.segments[0].sessionOpenMs),
      ...session(axis.segments[1].sessionOpenMs, 12, 3),
    ];
    const grown = [...base, candle(base[base.length - 1].ts_ms + 180_000)];

    expect(
      sameDayBoundaryTicks(
        resolveDayBoundaryTicks(base, axis),
        resolveDayBoundaryTicks(grown, axis),
      ),
    ).toBe(true);
  });
});
