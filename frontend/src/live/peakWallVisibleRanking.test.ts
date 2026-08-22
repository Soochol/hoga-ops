import { describe, it, expect } from 'vitest';
import type { IRange, Time } from 'lightweight-charts';
import type { AskPeakSegment } from '../chart/AskPeakSegmentsPrimitive';
import {
  PEAK_WALL_LEGEND_RANK_LIMIT,
  peakWallRankLegendCells,
  rankVisiblePeakSegments,
} from './peakWallVisibleRanking';
import { styleVisibleMaxAskPeakSegments } from './LiveAskPeakSegments';

/** 하루치 벽 하나. `day` 는 가상초 축에서의 그날 구간(=[day, day+100])이라
 *  보이는 범위와의 겹침 판정을 날짜 단위로 세울 수 있다. */
function seg(day: number, price: number, qty: number): AskPeakSegment {
  return {
    time0: day as Time,
    time1: (day + 100) as Time,
    peakTime: (day + 50) as Time,
    price,
    qty,
    label: `${price}, ${qty}`,
    color: '#base',
    lineWidth: 1,
  };
}

const range = (from: number, to: number): IRange<Time> =>
  ({ from: from as Time, to: to as Time });

describe('rankVisiblePeakSegments', () => {
  it('보이는 범위와 겹치는 벽만 잔량 내림차순 상위 N 개의 인덱스로 준다', () => {
    const segments = [
      seg(0, 1000, 50), // 범위 밖
      seg(1000, 2000, 30),
      seg(2000, 3000, 90),
      seg(3000, 4000, 60),
      seg(4000, 5000, 10),
    ];
    expect(rankVisiblePeakSegments(segments, range(900, 4200), 3)).toEqual([2, 3, 1]);
  });

  it('겹치는 벽이 limit 보다 적으면 있는 만큼만 준다(빈 자리를 만들지 않는다)', () => {
    const segments = [seg(0, 1000, 50), seg(1000, 2000, 30)];
    expect(rankVisiblePeakSegments(segments, range(-10, 1200), 3)).toEqual([0, 1]);
  });

  it('잔량이 같으면 먼저 나온 인덱스가 앞선다(안정 정렬)', () => {
    const segments = [seg(0, 1000, 40), seg(1000, 2000, 40), seg(2000, 3000, 40)];
    expect(rankVisiblePeakSegments(segments, range(-10, 2200), 2)).toEqual([0, 1]);
  });

  it('경계에 스치기만 해도 겹침이다(그날 구간의 끝 = 범위의 시작)', () => {
    const segments = [seg(0, 1000, 40)];
    expect(rankVisiblePeakSegments(segments, range(100, 500), 3)).toEqual([0]);
    expect(rankVisiblePeakSegments(segments, range(101, 500), 3)).toEqual([]);
  });

  it('보이는 범위를 모르면(null) 아무것도 고르지 않는다', () => {
    expect(rankVisiblePeakSegments([seg(0, 1000, 40)], null, 3)).toEqual([]);
  });

  it('limit 0 이면 아무것도 고르지 않는다(「보이는 영역 최대벽 표시 개수」 0)', () => {
    expect(rankVisiblePeakSegments([seg(0, 1000, 40)], range(-10, 200), 0)).toEqual([]);
  });
});

describe('peakWallRankLegendCells', () => {
  it('순위 라벨 + 「가격, 잔량」 셀을 상위 3개까지 만든다', () => {
    const segments = [seg(0, 918000, 900), seg(1000, 934000, 1800), seg(2000, 921000, 1200)];
    expect(peakWallRankLegendCells(segments, range(-10, 2200), 'ask-peak')).toEqual([
      { key: 'ask-peak-1', label: '1', value: '934,000, 1.8k' },
      { key: 'ask-peak-2', label: '2', value: '921,000, 1.2k' },
      { key: 'ask-peak-3', label: '3', value: '918,000, 0.9k' },
    ]);
  });

  it('4개 이상 겹쳐도 3개에서 끊는다', () => {
    const segments = [10, 20, 30, 40, 50].map((qty, i) => seg(i * 1000, 1000 + i, qty * 1000));
    const cells = peakWallRankLegendCells(segments, range(-10, 5200), 'ask-peak');
    expect(cells).toHaveLength(PEAK_WALL_LEGEND_RANK_LIMIT);
    expect(cells.map((c) => c.value)).toEqual(['1,004, 50k', '1,003, 40k', '1,002, 30k']);
  });

  it('보이는 범위에 벽이 없으면 빈 배열(레전드는 이름·아이콘만 남는다)', () => {
    expect(peakWallRankLegendCells([seg(0, 1000, 40)], range(5000, 6000), 'ask-peak')).toEqual([]);
  });
});

/**
 * **선 강조와 레전드가 같은 벽을 가리킨다.**
 *
 * 이 리팩터의 요점 — 랭킹이 두 벌이면 동점에서 조용히 갈려 선은 A 를 강조하는데 레전드
 * 1위는 B 가 된다. 두 소비처가 같은 `rankVisiblePeakSegments` 를 쓰는 한 원리적으로
 * 불가능하고, 이 테스트가 그 「한」을 고정한다.
 *
 * **막는 방향**: 어느 한쪽이 자기만의 정렬을 다시 갖는 것.
 * **못 보는 것**: 랭킹 **대상 집합**이 갈리는 것(레전드 ref 가 필터 전 세그먼트를 잡는 등)
 * — 그건 `LiveAskPeakSegments.test.tsx` 의 provider 테스트가 본다.
 */
describe('선 강조 ↔ 레전드 일치', () => {
  it('강조된 세그먼트 집합 = 레전드 상위 N 개', () => {
    // 1·2위가 동점(50) — 갈리려면 여기서 갈린다.
    const segments = [
      seg(0, 1000, 50),
      seg(1000, 2000, 50),
      seg(2000, 3000, 20),
      seg(3000, 4000, 70),
    ];
    const visible = range(-10, 4200);
    const styled = styleVisibleMaxAskPeakSegments(
      segments,
      visible,
      { color: '#hot', lineWidth: 3 },
      2,
    );
    const highlightedPrices = styled
      .filter((s) => s.color === '#hot')
      .map((s) => s.price)
      .sort((a, b) => a - b);
    const legendTop2 = rankVisiblePeakSegments(segments, visible, 2)
      .map((i) => segments[i].price)
      .sort((a, b) => a - b);
    expect(highlightedPrices).toEqual(legendTop2);
    expect(highlightedPrices).toEqual([1000, 4000]);
  });
});
