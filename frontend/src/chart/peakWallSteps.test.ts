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

  it('정합: 계단의 마지막 값 === 그날 세그먼트 qty 최댓값 (오버레이 수평선과 같은 숫자)', () => {
    const day1Walls = [wall(DAY1_OPEN + 1 * MIN, 9_000), wall(DAY1_OPEN + 4 * MIN, 29_000)];
    const out = buildPeakWallStepPoints(day1Walls, candles.slice(0, 6), axis, '#3485FA');
    const last = out[out.length - 1];
    expect('value' in last && last.value).toBe(Math.max(...day1Walls.map((w) => w.qty)));
  });
});
