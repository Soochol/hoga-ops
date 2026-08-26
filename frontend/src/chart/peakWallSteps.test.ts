import { describe, it, expect } from 'vitest';
import type { Time } from 'lightweight-charts';
import { createVirtualAxis } from '../util/virtualAxis';
import type { Candle } from '../api/types';
import type { PeakWallSegment } from './PeakWallSegmentsPrimitive';
import { buildPeakWallStepPoints, buildUnreachedStepPoints, type PeakWallStepPoint } from './peakWallSteps';
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

/**
 * 미도달 계단이 재는 축 **둘**.
 *
 * ① **단조가 아니다** — 막는 방향: 미도달 계열에 running max 빌더
 * (`buildPeakWallStepPoints`)를 쓰는 것. 그 빌더는 이미 깨진 벽을 계단 높이로 영원히
 * 남기므로 **틀린 선**이 된다. 첫 테스트가 같은 입력에 두 빌더를 태워 그 대조를 값으로
 * 못박는다.
 *
 * ② **후보가 비는 봉은 0(흐린 색)** — 막는 방향: 선을 끊어 빈 구간을 만드는 것
 * (2026-08-26 이전 동작). 「그 시점에 미도달 벽이 없다」는 부재가 아니라 값이고, 색이
 * 그 구간을 급락과 구별한다. **단, 그날 벽 데이터가 아예 없으면 0 도 내지 않는다** —
 * 캡처 누락에 0 을 그리면 하지 않은 주장을 하는 것이다.
 *
 * 못 보는 것: top-3 밖의 벽 — wire 가 나르지 않는다. 그 절단이 0 을 거짓으로 만들 수
 * 있어 **후보 풀 확장(`toUnreachedStepPeakInputs`)이 0-fill 의 전제**이고, 그쪽 대조는
 * `live/peakWallSegments.test.ts` 가 잰다. 이 파일은 빌더만 본다.
 */
describe('buildUnreachedStepPoints', () => {
  const COLOR = '#1E3A8A';
  const ABSENT = 'rgba(30, 58, 138, 0.3)';

  // 고가가 장중에 오르는 하루: 09:00~09:02 는 105, 09:03 부터 **1,200 까지** 오른다.
  // 매도 미도달 판정은 `price > 누적 고가` 라 1,100 벽은 09:03 에 도달당한다.
  const risingDay: Candle[] = [0, 1, 2, 3, 4, 5].map((i) => ({
    ts_ms: DAY1_OPEN + i * MIN,
    open: 100, high: i >= 3 ? 1_200 : 105, low: 90, close: 105, vol_a: 1, vol_b: 1,
  } as Candle));

  function priced(peakRealMs: number, qty: number, price: number): PeakWallSegment {
    return { ...wall(peakRealMs, qty), price };
  }

  it('고가가 벽을 넘으면 계단이 내려간다 — running max 빌더는 못 하는 일', () => {
    const segments = [
      priced(DAY1_OPEN, 9_000, 1_100),        // 09:03 에 고가 1,200 이 지배 → 이탈
      priced(DAY1_OPEN, 3_000, 5_000),        // 계속 미도달(5,000 > 1,200)
    ];
    const unreached = buildUnreachedStepPoints(segments, risingDay, axis, COLOR, 'ask', ABSENT);
    const values = valuesOf(unreached);

    // 09:00~09:02 는 9,000(둘 다 미도달), 09:03 부터 3,000 으로 **하락**.
    expect(values).toEqual([9_000, 9_000, 9_000, 3_000, 3_000, 3_000]);
    // 값이 있는 구간은 전부 본색이다 — 흐린 색은 0 구간의 표시다.
    expect(unreached.map((p) => p.color)).toEqual(Array(6).fill(COLOR));

    // 대조: 같은 입력을 running max 빌더에 태우면 9,000 이 끝까지 남는다 —
    // 이 테스트가 잡는 것이 정확히 그 차이다.
    const monotone = valuesOf(buildPeakWallStepPoints(segments, risingDay, axis, COLOR));
    expect(monotone).toEqual([9_000, 9_000, 9_000, 9_000, 9_000, 9_000]);
  });

  it('후보가 전부 도달당하면 선을 끊지 않고 0 을 흐린 색으로 잇는다', () => {
    const segments = [priced(DAY1_OPEN, 9_000, 1_100)];
    const points = buildUnreachedStepPoints(segments, risingDay, axis, COLOR, 'ask', ABSENT);

    // 09:03 부터 미도달 벽이 없다 — 부재가 아니라 **0** 이고, 봉은 계속 나온다.
    expect(valuesOf(points)).toEqual([9_000, 9_000, 9_000, 0, 0, 0]);
    expect(points.map((p) => p.color)).toEqual(
      [COLOR, COLOR, COLOR, ABSENT, ABSENT, ABSENT],
    );
  });

  it('벽이 서기 전 봉도 0(흐린 색)으로 채운다 — 그날 벽 데이터는 있으므로', () => {
    const segments = [priced(DAY1_OPEN + 2 * MIN, 9_000, 5_000)];
    const points = buildUnreachedStepPoints(segments, risingDay, axis, COLOR, 'ask', ABSENT);
    // 6봉 전부 나온다(종전엔 09:02 부터 4봉).
    expect(points.map((p) => Number(p.time))).toEqual(
      [0, 1, 2, 3, 4, 5].map((i) => vsecOf(DAY1_OPEN + i * MIN)),
    );
    expect(valuesOf(points)).toEqual([0, 0, 9_000, 9_000, 9_000, 9_000]);
    expect(points.slice(0, 2).map((p) => p.color)).toEqual([ABSENT, ABSENT]);
  });

  it('벽 데이터가 없는 거래일에는 0 도 내지 않는다 — 캡처 누락과 「전부 도달」은 다르다', () => {
    // 벽은 DAY1 에만 있고 DAY2 에는 없다. DAY2 의 6봉은 점이 없어야 한다.
    const segments = [priced(DAY1_OPEN, 9_000, 5_000)];
    const points = buildUnreachedStepPoints(segments, candles, axis, COLOR, 'ask', ABSENT);
    const day2Start = vsecOf(DAY2_OPEN);
    expect(points.every((p) => Number(p.time) < day2Start)).toBe(true);
    expect(points).toHaveLength(6);
  });

  it('매수는 저가 기준으로 대칭이다', () => {
    const fallingDay: Candle[] = [0, 1, 2, 3, 4, 5].map((i) => ({
      ts_ms: DAY1_OPEN + i * MIN,
      open: 100, high: 110, low: i >= 3 ? 500 : 900, close: 105, vol_a: 1, vol_b: 1,
    } as Candle));
    const segments = [
      priced(DAY1_OPEN, 9_000, 800),   // 저가 500 이 09:03 에 지배(800 > 500) → 이탈
      priced(DAY1_OPEN, 3_000, 100),   // 계속 미도달(100 < 500)
    ];
    const values = valuesOf(
      buildUnreachedStepPoints(segments, fallingDay, axis, '#7F1D1D', 'bid', ABSENT),
    );
    expect(values).toEqual([9_000, 9_000, 9_000, 3_000, 3_000, 3_000]);
  });

  it('거래일 경계는 종전대로 투명으로 끊는다 — 0-fill 이 그 처리를 삼키지 않는다', () => {
    const segments = [
      priced(DAY1_OPEN, 9_000, 5_000),
      priced(DAY2_OPEN, 4_000, 5_000),
    ];
    const points = buildUnreachedStepPoints(segments, candles, axis, COLOR, 'ask', ABSENT);
    const day2Start = vsecOf(DAY2_OPEN);
    const boundary = points.findIndex((p) => Number(p.time) >= day2Start);
    expect(boundary).toBeGreaterThan(0);
    // 이전 날 마지막 점(수평부)과 새 날 첫 점(수직부)이 둘 다 투명.
    expect(points[boundary - 1]).toMatchObject(LINE_HIDDEN_COLOR);
    expect(points[boundary]).toMatchObject(LINE_HIDDEN_COLOR);
  });
});
