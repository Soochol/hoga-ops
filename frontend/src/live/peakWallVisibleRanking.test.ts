import { describe, it, expect } from 'vitest';
import type { IRange, Time } from 'lightweight-charts';
import type { PeakWallSegment } from '../chart/PeakWallSegmentsPrimitive';
import {
  PEAK_WALL_LEGEND_RANK_LIMIT,
  peakWallRankLegendCells,
  rankVisiblePeakSegments,
} from './peakWallVisibleRanking';
import { peakWallRankArrowsFromSegments } from './peakWallRankArrows';
import type { VirtualAxis } from '../util/virtualAxis';
import { candleExtremesByVirtualSec } from './peakWallRankArrows';

/** 하루치 벽 하나. `day` 는 가상초 축에서의 그날 구간(=[day, day+100])이라
 *  보이는 범위와의 겹침 판정을 날짜 단위로 세울 수 있다. */
function seg(day: number, price: number, qty: number): PeakWallSegment {
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
 * **레전드와 순위 화살표가 같은 벽을 가리킨다.**
 *
 * 이 리포에서 랭킹의 소비처는 셋이다 — 레전드 셀 · 순위 화살표 · 고저 라벨 회피.
 * 랭킹이 두 벌이면 동점(같은 잔량)에서 조용히 갈려 레전드 1위와 화살표 ① 이 다른 벽을
 * 가리킨다. 셋이 같은 `rankVisiblePeakSegments` 를 쓰는 한 원리적으로 불가능하고,
 * 이 테스트가 그 「한」을 고정한다.
 *
 * (2026-08-23: 네 번째 소비처였던 「보이는 영역 최대벽」 색 강조는 제거됐다 — 레전드와
 * 화살표의 ①②③ 이 같은 정보를 순위까지 정확히 나르므로 색 채널이 중복이었다.)
 *
 * **막는 방향**: 어느 한쪽이 자기만의 정렬을 다시 갖는 것.
 * **못 보는 것**: 랭킹 **대상 집합**이 갈리는 것(화살표가 필터 전 세그먼트를 잡는 등)
 * — 그건 컴포넌트 테스트가 본다.
 */
describe('레전드 ↔ 순위 화살표 일치', () => {
  it('두 표면이 같은 순서로 같은 벽을 고른다(동점 포함)', () => {
    // 1·2위가 동점(50) — 갈리려면 여기서 갈린다.
    const segments = [
      seg(0, 1000, 50),
      seg(1000, 2000, 50),
      seg(2000, 3000, 20),
      seg(3000, 4000, 70),
    ];
    const visible = range(-10, 4200);
    // 화살표는 봉 극값에 매달리므로 각 peakTime 에 캔들을 하나씩 둔다.
    const axis = { toVirtual: (ms: number) => ms } as unknown as VirtualAxis;
    const extremes = candleExtremesByVirtualSec(
      segments.map((s) => ({
        ts_ms: Number(s.peakTime) * 1000,
        open: 0, high: s.price + 1, low: s.price - 1, close: 0, vol_a: 0, vol_b: 0,
      })),
      axis,
    );
    const arrows = peakWallRankArrowsFromSegments(segments, 'ask', extremes);

    const legendValues = peakWallRankLegendCells(segments, visible, 'ask-peak').map((c) => c.value);
    const arrowOrder = rankVisiblePeakSegments(arrows, visible, PEAK_WALL_LEGEND_RANK_LIMIT)
      .map((i) => arrows[i].anchorPrice - 1); // 고가 = price + 1 로 뒀으므로 되돌린다

    expect(arrowOrder).toEqual([4000, 1000, 2000]);
    expect(legendValues[0]).toContain('4,000');
    expect(legendValues[1]).toContain('1,000');
    expect(legendValues[2]).toContain('2,000');
  });
});
