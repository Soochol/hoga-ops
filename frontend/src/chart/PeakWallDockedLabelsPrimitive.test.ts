import { describe, expect, it } from 'vitest';
import {
  dockedLabelTimeToX,
  peakWallDockedLabelCandidates,
  type PeakWallDockedLabelCandidatesArgs,
  type PeakWallDockedLabelInput,
} from './PeakWallDockedLabelsPrimitive';
import type { ITimeScaleApi, Time } from 'lightweight-charts';

const label = (
  overrides: Partial<PeakWallDockedLabelInput> = {},
): PeakWallDockedLabelInput => ({
  price: 24500,
  label: '16.6k',
  color: '#f97316',
  time0: 100 as Time,
  time1: 200 as Time,
  peakTime: 150 as Time,
  side: 'ask',
  ...overrides,
});

/** 시각 → x 의 선형 스텁: time 100→200px, 200→400px (배율 2). */
const linearTimeToX = (time: Time): number => (time as unknown as number) * 2;

const args = (
  labels: readonly PeakWallDockedLabelInput[],
  overrides: Partial<PeakWallDockedLabelCandidatesArgs> = {},
): PeakWallDockedLabelCandidatesArgs => ({
  labels,
  priceToY: () => 300,
  timeToX: linearTimeToX,
  rawPeakX: linearTimeToX,
  measureText: (text) => text.length * 6,
  paneWidth: 1000,
  ...overrides,
});

describe('peakWallDockedLabelCandidates', () => {
  it('라벨을 발생 분봉 x 에 중앙 정렬한다 — 선 끝(time1)이 아니다', () => {
    const [candidate] = peakWallDockedLabelCandidates(args([label()]));

    // peakTime 150 → x 300. 선 끝(time1 200 → x 400)이 아니라 여기에 중심이 온다.
    expect(candidate.peakX).toBe(300);
    expect(candidate.xRight - candidate.width / 2).toBeCloseTo(300, 6);
  });

  it('매도는 선 위, 매수는 선 아래 baseline 을 희망한다', () => {
    const [ask] = peakWallDockedLabelCandidates(args([label({ side: 'ask' })]));
    const [bid] = peakWallDockedLabelCandidates(args([label({ side: 'bid' })]));

    expect(ask.yLine).toBeLessThan(300);
    expect(bid.yLine).toBeGreaterThan(300);
  });

  it('peak 시각이 로드 범위 밖(null)이어도 보간으로 앵커를 만든다 — 라벨이 사라지지 않는다', () => {
    const [candidate] = peakWallDockedLabelCandidates(args(
      [label({ peakTime: 150 as Time })],
      { rawPeakX: () => null },
    ));

    // [time0,time1] = [100,200] 의 50% → x 는 [200,400] 의 50% 인 300.
    expect(candidate.peakX).toBe(300);
  });

  it('빈 라벨 텍스트는 건너뛴다', () => {
    const out = peakWallDockedLabelCandidates(args([label({ label: '' }), label()]));
    expect(out.map((c) => c.index)).toEqual([1]);
  });

  it('가격을 y 로 못 옮기면 건너뛴다 — 축 밖 벽', () => {
    const out = peakWallDockedLabelCandidates(args(
      [label({ price: 24500 }), label({ price: 23500 })],
      { priceToY: (price) => (price === 24500 ? 300 : null) },
    ));
    expect(out.map((c) => c.index)).toEqual([0]);
  });

  it('세그먼트 끝점을 x 로 못 옮기면 건너뛴다 — 그날 구간 클램프 입력이 없다', () => {
    const out = peakWallDockedLabelCandidates(args([label()], { timeToX: () => null }));
    expect(out).toEqual([]);
  });

  it('점(dot)의 y 를 실어 나른다 — 회피로 밀린 칩에 리더선을 잇기 위해', () => {
    const [candidate] = peakWallDockedLabelCandidates(args([label()], { priceToY: () => 275 }));
    expect(candidate.lineY).toBe(275);
  });

  it('bitmap 배율을 받으면 기하가 그대로 확대된다', () => {
    const [media] = peakWallDockedLabelCandidates(args([label()]));
    const [bitmap] = peakWallDockedLabelCandidates(args([label()], {
      priceToY: () => 600,
      timeToX: (time) => linearTimeToX(time) * 2,
      rawPeakX: (time) => linearTimeToX(time) * 2,
      measureText: (text) => text.length * 12,
      paneWidth: 2000,
      horizontalScale: 2,
      verticalScale: 2,
    }));

    expect(bitmap.xRight).toBeCloseTo(media.xRight * 2, 6);
    expect(bitmap.yLine).toBeCloseTo(media.yLine * 2, 6);
  });
});

function timeScaleStub(overrides: Partial<Record<'timeToCoordinate' | 'timeToIndex' | 'logicalToCoordinate', (...args: never[]) => unknown>>) {
  return {
    timeToCoordinate: () => null,
    timeToIndex: () => null,
    logicalToCoordinate: () => null,
    ...overrides,
  } as unknown as ITimeScaleApi<Time>;
}

describe('dockedLabelTimeToX', () => {
  it('timeToCoordinate가 좌표를 주면 픽셀비만 곱해 그대로 쓴다', () => {
    const toX = dockedLabelTimeToX(timeScaleStub({ timeToCoordinate: () => 123 }), 2);
    expect(toX(1000 as Time)).toBe(246);
  });

  it('범위 밖 시각(null)은 가장 가까운 봉으로 클램프한다 — 통합(UN) 확장 세션 close(20:00)가 마지막 봉 밖이면 당일 최대벽 라벨만 사라지던 결함', () => {
    const calls: unknown[][] = [];
    const toX = dockedLabelTimeToX(
      timeScaleStub({
        timeToCoordinate: () => null,
        timeToIndex: (...args: never[]) => {
          calls.push(args);
          return 42;
        },
        logicalToCoordinate: () => 650,
      }),
      2,
    );
    expect(toX(1000 as Time)).toBe(1300);
    // findNearest=true 로 가장 가까운 봉을 찾아야 한다(정확 일치 요구 금지).
    expect(calls[0]?.[1]).toBe(true);
  });

  it('가장 가까운 봉조차 없으면(빈 차트) null — 라벨 skip 동작 유지', () => {
    const toX = dockedLabelTimeToX(timeScaleStub({}), 2);
    expect(toX(1000 as Time)).toBeNull();
  });
});
