import { describe, it, expect } from 'vitest';
import type { Time } from 'lightweight-charts';
import { createVirtualAxis } from '../util/virtualAxis';
import type { Candle } from '../api/types';
import type { PeakWallSegment } from './PeakWallSegmentsPrimitive';
import { buildPeakWallStepPoints, type PeakWallStepPoint } from './peakWallSteps';
import { LINE_HIDDEN_COLOR } from './util/auctionHide';

// ── 픽스처 ────────────────────────────────────────────────────────────────
// 2거래일, 각 6분(09:00~09:06). 세션 갭이 있어야 거래일 경계 리셋·whitespace 끊기가
// 실제 축 위에서 검증된다.

const MIN = 60_000;
const DAY1_OPEN = Date.UTC(2026, 7, 20, 0, 0); // KST 09:00
const DAY2_OPEN = Date.UTC(2026, 7, 21, 0, 0);

const axis = createVirtualAxis([
  { date: '20260820', sessionOpenMs: DAY1_OPEN, sessionCloseMs: DAY1_OPEN + 6 * MIN },
  { date: '20260821', sessionOpenMs: DAY2_OPEN, sessionCloseMs: DAY2_OPEN + 6 * MIN },
]);

function candle(tsMs: number): Candle {
  return {
    ts_ms: tsMs, open: 100, high: 110, low: 90, close: 105, vol_a: 1, vol_b: 1,
  } as Candle;
}

const candles: Candle[] = [
  ...[0, 1, 2, 3, 4, 5].map((i) => candle(DAY1_OPEN + i * MIN)),
  ...[0, 1, 2, 3, 4, 5].map((i) => candle(DAY2_OPEN + i * MIN)),
];

/** 벽 세그먼트 — 계단 계산이 읽는 것은 peakTime(가상초)·qty 뿐이다. */
function wall(peakRealMs: number, qty: number): PeakWallSegment {
  const vsec = axis.toVirtual(peakRealMs) / 1000;
  return {
    time0: vsec as Time, time1: vsec as Time, peakTime: vsec as Time,
    price: 1000, qty, label: '', color: '#3485FA', lineWidth: 2, live: false,
  } as PeakWallSegment;
}

const vsecOf = (realMs: number): number => axis.toVirtual(realMs) / 1000;
const valuesOf = (points: readonly PeakWallStepPoint[]) => points.map((p) => p.value);

describe('buildPeakWallStepPoints', () => {
  it('당일 누적 최대만 그린다 — 작은 벽이 뒤에 와도 내려가지 않는다', () => {
    const out = buildPeakWallStepPoints(
      [wall(DAY1_OPEN + 1 * MIN, 9_000), wall(DAY1_OPEN + 3 * MIN, 29_000)],
      candles.slice(0, 6), axis, '#3485FA',
    );
    // 첫 벽(1분) 전의 0분 캔들은 점이 없다. 1~2분 = 9천, 3분부터 2.9만.
    expect(out.map((p) => Number(p.time))).toEqual(
      [1, 2, 3, 4, 5].map((i) => vsecOf(DAY1_OPEN + i * MIN)),
    );
    expect(valuesOf(out)).toEqual([9_000, 9_000, 29_000, 29_000, 29_000]);
  });

  it('벽이 역순 크기로 서면(큰 것 먼저) 계단은 한 단', () => {
    const out = buildPeakWallStepPoints(
      [wall(DAY1_OPEN + 1 * MIN, 29_000), wall(DAY1_OPEN + 3 * MIN, 9_000)],
      candles.slice(0, 6), axis, '#3485FA',
    );
    expect(valuesOf(out)).toEqual([29_000, 29_000, 29_000, 29_000, 29_000]);
  });

  it('거래일 경계에서 리셋되고, 이전 날 마지막 점의 outgoing 이 투명으로 끊긴다', () => {
    const out = buildPeakWallStepPoints(
      [wall(DAY1_OPEN + 1 * MIN, 29_000), wall(DAY2_OPEN + 2 * MIN, 5_000)],
      candles, axis, '#3485FA',
    );
    // day1 5점(1~5분, 전부 2.9만) + day2 4점(2~5분, 전부 5천) — whitespace 없음.
    // ⚠ lwc LineSeries 는 whitespace 를 무시하고 선을 이어 그린다(실화면 검증) —
    //   끊기는 이전 날 **마지막 점의 outgoing 색 투명**(maskOutgoingConnector)이 맡는다.
    expect(valuesOf(out)).toEqual([
      29_000, 29_000, 29_000, 29_000, 29_000,
      5_000, 5_000, 5_000, 5_000,
    ]);
    // 경계 양쪽 두 점이 투명 — day1 마지막(outgoing=스텝 수평부)과 day2 첫 점
    // (수직부는 도착점 색 — 실화면 검증). 나머지는 지정색 유지.
    expect(out[4].color).toBe(LINE_HIDDEN_COLOR.color);
    expect(out[5].color).toBe(LINE_HIDDEN_COLOR.color);
    expect(out[3].color).toBe('#3485FA');
    expect(out[6].color).toBe('#3485FA');
    // 리셋의 핵심: day2 값이 day1 최대(2.9만)를 물려받지 않는다.
    expect(valuesOf(out).slice(5)).not.toContain(29_000);
  });

  it('동률은 먼저 도달한 것을 유지한다 (strict > — foldAskPeak 규약 미러)', () => {
    // 같은 qty 의 벽이 두 번 서도 값은 변하지 않고 점 개수도 그대로다.
    const out = buildPeakWallStepPoints(
      [wall(DAY1_OPEN + 1 * MIN, 9_000), wall(DAY1_OPEN + 3 * MIN, 9_000)],
      candles.slice(0, 6), axis, '#3485FA',
    );
    expect(valuesOf(out)).toEqual([9_000, 9_000, 9_000, 9_000, 9_000]);
  });

  it('빈 입력·축 밖 벽은 빈 배열', () => {
    expect(buildPeakWallStepPoints([], candles, axis, '#3485FA')).toEqual([]);
    expect(buildPeakWallStepPoints([wall(DAY1_OPEN, 1)], [], axis, '#3485FA')).toEqual([]);
    // 축 밖 벽(findByVirtual → -1)은 이벤트에서 걸러진다. ⚠ real ms 로 만들면
    // toVirtual 이 0 으로 클램프해 가드에 닿지 않는다(탐침이 판별식을 못 건드림) —
    // 가상초를 직접 음수로 줘야 findByVirtual 이 실제로 -1 을 돌려준다.
    const preAxisWall = { ...wall(DAY1_OPEN, 9_000), peakTime: -100 as Time };
    expect(buildPeakWallStepPoints(
      [preAxisWall], candles.slice(0, 6), axis, '#3485FA',
    )).toEqual([]);
  });

  it('세션 밖 캔들은 점을 내지 않는다 — 클램프 중복이 lwc 단언을 못 터뜨린다', () => {
    // ⚠ 실사고 재현(2026-08-24): `toVirtual` 은 세션 밖 시각을 경계로 **클램프**한다.
    // **마지막 날의 마감 후(시간외) 캔들**이 둘이면 둘 다 같은 가상초로 클램프되고
    // — 다음 세그먼트가 없어 day 리셋으로도 안 걸러진다 — setData 가
    // "data must be asc ordered by time" 단언으로 차트 전체를 죽였다.
    // (중간 날의 마감 후 캔들은 클램프가 다음 세그먼트로 떨어져 running=null 로
    // 우연히 스킵된다 — 그 형태의 탐침은 가드를 지워도 안 빨개진다. red-check 실측.)
    const withAfterHours = [
      ...candles,
      candle(DAY2_OPEN + 10 * MIN),   // 마지막 날 마감(+6분) 후 — 시간외 행
      candle(DAY2_OPEN + 20 * MIN),   // 둘째 — 같은 값으로 클램프되는 쌍
    ];
    const out = buildPeakWallStepPoints(
      [wall(DAY1_OPEN + 1 * MIN, 9_000), wall(DAY2_OPEN + 1 * MIN, 5_000)],
      withAfterHours, axis, '#3485FA',
    );
    const times = out.map((pt) => Number(pt.time));
    // (a) 어떤 입력에서든 시각은 강한 단조 증가 — lwc 단언의 생산자 쪽 보증.
    expect(times.every((t, i) => i === 0 || t > times[i - 1])).toBe(true);
    // (b) 세션 밖 캔들은 아예 기여하지 않는다 — 마지막 값 점이 day2 의 마지막
    //     **세션 내** 캔들이다. (단조 가드만으로는 첫 클램프 점 하나가 살아남으므로
    //     (a)와 별개 탐침이다.)
    expect(times[times.length - 1]).toBe(vsecOf(DAY2_OPEN + 5 * MIN));
  });

  it('정합: 계단의 마지막 값 === 그날 세그먼트 qty 최댓값 (오버레이 수평선과 같은 숫자)', () => {
    const day1Walls = [wall(DAY1_OPEN + 1 * MIN, 9_000), wall(DAY1_OPEN + 4 * MIN, 29_000)];
    const out = buildPeakWallStepPoints(day1Walls, candles.slice(0, 6), axis, '#3485FA');
    const last = out[out.length - 1];
    expect('value' in last && last.value).toBe(Math.max(...day1Walls.map((w) => w.qty)));
  });
});
