import { describe, expect, it } from 'vitest';
import { buildPeakBarSeries, EMPTY_PEAK_BAR_SERIES } from './peakWallBarSeries';
import type { AskPeakCandidate } from '../api/types';

const MIN = 60_000;
/** 분 인덱스로 후보를 만든다 — 접기 키가 분이므로 시각을 분으로 읽는 편이 정직하다. */
const c = (price: number, qty: number, minute: number): AskPeakCandidate => (
  { price, qty, t_ms: minute * MIN }
);

describe('buildPeakBarSeries', () => {
  it('seed 와 라이브 스냅샷을 합쳐 시각순으로 낸다', () => {
    const series = buildPeakBarSeries(
      { traded_bar_peaks: [c(100, 50, 3)], traded_bar_max_peaks: [c(100, 60, 3)] },
      { traded_bar_peaks: [c(110, 900, 9), c(105, 300, 5)] },
    );
    expect(series.close).toEqual([c(100, 50, 3), c(105, 300, 5), c(110, 900, 9)]);
    // 라이브는 축 구분이 없어 cont 쪽에도 같은 배열이 실린다(seed 만 두 축이 다르다).
    expect(series.max).toEqual([c(100, 60, 3), c(105, 300, 5), c(110, 900, 9)]);
  });

  it('같은 분을 두 출처가 다르게 보면 **큰 쪽**이 그 분의 값이다', () => {
    // seed 는 프로모션까지, 라이브는 서버 상태 전체 — 둘 다 부분 관측이라 max 가 정답.
    const series = buildPeakBarSeries(
      { traded_bar_peaks: [c(100, 500, 7)] },
      { traded_bar_peaks: [c(101, 900, 7)] },
    );
    expect(series.close).toEqual([c(101, 900, 7)]);
  });

  it('한 분에 하나만 남긴다 — 동률은 먼저 온 것을 유지한다', () => {
    // 같은 분의 두 후보(백엔드가 이미 접어 보내지만, 두 출처를 합치면 생길 수 있다).
    const series = buildPeakBarSeries(
      null,
      { traded_bar_peaks: [c(100, 300, 4), c(105, 300, 4), c(110, 100, 4)] },
    );
    expect(series.close).toEqual([c(100, 300, 4)]);
  });

  it('분 경계를 넘으면 각자 남는다', () => {
    const series = buildPeakBarSeries(
      null,
      // 같은 분(4분 0초 · 4분 59초) 둘 + 다음 분 하나.
      { traded_bar_peaks: [
        { price: 100, qty: 200, t_ms: 4 * MIN },
        { price: 101, qty: 700, t_ms: 4 * MIN + 59_000 },
        { price: 102, qty: 300, t_ms: 5 * MIN },
      ] },
    );
    expect(series.close.map((x) => x.qty)).toEqual([700, 300]);
  });

  it('한쪽만 있어도 그쪽 값을 낸다', () => {
    expect(buildPeakBarSeries({ traded_bar_peaks: [c(100, 50, 1)] }, null).close)
      .toEqual([c(100, 50, 1)]);
    expect(buildPeakBarSeries(null, { traded_bar_peaks: [c(100, 50, 1)] }).close)
      .toEqual([c(100, 50, 1)]);
  });

  it('둘 다 비면 빈 계열 — top-3 폴백이 없다', () => {
    // 계단 모드는 기록이 없으면 top-3 으로 떨어지지만, 봉별에는 그 폴백이 **없다**:
    // top-3 은 그날 최종 크기순이라 세 봉만 값이 있는 틀린 화면이 된다.
    const series = buildPeakBarSeries(null, null);
    expect(series).toEqual(EMPTY_PEAK_BAR_SERIES);
  });

  it('시각·잔량이 유한하지 않은 후보는 버린다', () => {
    const series = buildPeakBarSeries(null, {
      traded_bar_peaks: [
        { price: 100, qty: Number.NaN, t_ms: 1 * MIN },
        { price: 101, qty: 500, t_ms: Number.NaN },
        { price: 102, qty: 300, t_ms: 2 * MIN },
      ],
    });
    expect(series.close).toEqual([c(102, 300, 2)]);
  });
});

describe('buildPeakBarSeries — 계열 선택', () => {
  const seed = {
    traded_bar_peaks: [c(100, 50, 1)],
    traded_bar_max_peaks: [c(100, 60, 1)],
    all_bar_peaks: [c(200, 700, 1)],
    all_bar_max_peaks: [c(200, 800, 1)],
  };
  const live = {
    traded_bar_peaks: [c(101, 90, 2)],
    all_bar_peaks: [c(201, 900, 2)],
  };

  it("family='all' 은 전체 계열 필드를 읽는다", () => {
    const series = buildPeakBarSeries(seed, live, 'all');
    expect(series.close).toEqual([c(200, 700, 1), c(201, 900, 2)]);
    expect(series.max).toEqual([c(200, 800, 1), c(201, 900, 2)]);
  });

  it('기본값은 체결 계열이다 — 두 계열이 섞이지 않는다', () => {
    const series = buildPeakBarSeries(seed, live);
    expect(series.close).toEqual([c(100, 50, 1), c(101, 90, 2)]);
    // 전체 계열 값(700·900)이 새어 들어오면 안 된다.
    expect(series.close.some((x) => x.qty >= 700)).toBe(false);
  });

  it('한 계열만 있는 payload 에서 다른 계열은 빈다', () => {
    expect(buildPeakBarSeries({ traded_bar_peaks: [c(100, 50, 1)] }, null, 'all').close)
      .toEqual([]);
  });
});

describe("buildPeakBarSeries — family='unreached'", () => {
  it('단일 축이라 seed 의 같은 배열을 양쪽에 싣는다', () => {
    const series = buildPeakBarSeries(
      { unreached_bar_peaks: [c(300, 400, 1)] },
      { unreached_bar_peaks: [c(301, 600, 2)] },
      'unreached',
    );
    // 하루 판(`unreached_peaks`)이 cont 단일인 것과 같은 규약 — intraMax 가 무효다.
    expect(series.close).toEqual([c(300, 400, 1), c(301, 600, 2)]);
    expect(series.max).toEqual(series.close);
  });

  it('다른 계열 필드를 읽지 않는다', () => {
    const series = buildPeakBarSeries(
      { traded_bar_peaks: [c(100, 50, 1)], all_bar_peaks: [c(200, 700, 1)] },
      null,
      'unreached',
    );
    expect(series.close).toEqual([]);
  });
});
