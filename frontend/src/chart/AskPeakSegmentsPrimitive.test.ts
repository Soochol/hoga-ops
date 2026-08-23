import { describe, expect, it } from 'vitest';
import type { ITimeScaleApi, Time } from 'lightweight-charts';
import {
  xCoordinateOrNearest,
  layoutAskPeakLabels,
  peakWallChipGeometry,
  peakXFromCoordinate,
  LABEL_BOX_X_PAD_PX,
  LABEL_BOX_Y_PAD_PX,
  LABEL_FONT_PX,
  LABEL_GAP_PX,
  PEAK_DOT_RADIUS_PX,
  inlinePeakWallSegmentsForDocking,
  livePeakWallDockedLabelsFromSegments,
  peakLabelBudgetForBarSpacing,
  PEAK_LABEL_HIDE_BAR_SPACING_PX,
  PEAK_LABEL_BUDGET_MAX,
  PEAK_LABEL_BUDGET_MIN,
  visibleAskPeakLabelCandidates,
  type AskPeakLabelCandidate,
  type PeakWallSegment,
} from './AskPeakSegmentsPrimitive';

const candidate = (
  index: number,
  xRight: number,
  yLine: number,
  width = 70,
  segmentWidth = 120,
): AskPeakLabelCandidate => ({
  index,
  xRight,
  yLine,
  width,
  segmentWidth,
});

describe('layoutAskPeakLabels', () => {
  it('separates overlapping labels that share the same right edge', () => {
    const out = layoutAskPeakLabels([
      candidate(0, 500, 100),
      candidate(1, 500, 104),
      candidate(2, 500, 108),
    ], 15, 220, 13);

    expect(out.map((l) => l.baselineY)).toEqual([100, 113, 126]);
  });

  it('uses the requested row height as the readable gap between close labels', () => {
    const out = layoutAskPeakLabels([
      candidate(0, 500, 100),
      candidate(1, 500, 108),
      candidate(2, 500, 116),
    ], 15, 220, 16);

    expect(out.map((l) => l.baselineY)).toEqual([100, 116, 132]);
  });

  it('leaves nearby y labels alone when their text boxes do not overlap horizontally', () => {
    const out = layoutAskPeakLabels([
      candidate(0, 150, 100),
      candidate(1, 500, 104),
    ], 15, 220, 13);

    expect(out.map((l) => l.baselineY)).toEqual([100, 104]);
  });

  it('keeps stacked labels inside the pane near the bottom edge', () => {
    const out = layoutAskPeakLabels([
      candidate(0, 500, 202),
      candidate(1, 500, 206),
      candidate(2, 500, 210),
    ], 15, 220, 13);

    expect(out.map((l) => l.baselineY)).toEqual([194, 207, 220]);
  });
});

describe('visibleAskPeakLabelCandidates', () => {
  it('hides labels when zoomed out so the segment cannot fit the label', () => {
    const out = visibleAskPeakLabelCandidates([
      candidate(0, 500, 100, 70, 120),
      candidate(1, 540, 104, 70, 60),
    ], 8);

    expect(out.map((l) => l.index)).toEqual([0]);
  });
});

describe('peakLabelBudgetForBarSpacing', () => {
  it('hides all labels when zoomed out below the floor', () => {
    expect(peakLabelBudgetForBarSpacing(PEAK_LABEL_HIDE_BAR_SPACING_PX - 0.5)).toBe(0);
    expect(peakLabelBudgetForBarSpacing(0)).toBe(0);
    expect(peakLabelBudgetForBarSpacing(NaN)).toBe(0);
  });

  it('ramps from MIN at the floor to MAX when zoomed in', () => {
    expect(peakLabelBudgetForBarSpacing(PEAK_LABEL_HIDE_BAR_SPACING_PX)).toBe(PEAK_LABEL_BUDGET_MIN);
    expect(peakLabelBudgetForBarSpacing(1000)).toBe(PEAK_LABEL_BUDGET_MAX);
  });

  // ⚠ 위 두 테스트는 **상수를 참조**하므로 임계를 바꿔도 통과한다(형태만 본다).
  // 임계 자체는 라벨 폭에 묶인 값이라 여기서 대표 줌의 개수를 못박는다 — 라벨 포맷이
  // 바뀌면(칩 폭이 바뀌면) 이 숫자들도 같이 재조정돼야 한다는 것을 실패로 알린다.
  it('대표 줌에서의 개수를 못박는다 — 라벨 폭(「가격, 잔량」)에 맞춘 임계', () => {
    // 실측 칩 폭 ~70px(11px sans-serif, 패딩 포함). 잔량만이던 시절(~34px)의 약 2배라
    // 임계도 3.5/16 → 6/33 으로 옮겼다(사유는 상수 자리 주석).
    expect(peakLabelBudgetForBarSpacing(4)).toBe(0);    // 칩 하나가 봉 17개를 덮는 폭 → 숨김
    expect(peakLabelBudgetForBarSpacing(6)).toBe(2);    // 하한: 최소 2개는 보인다
    expect(peakLabelBudgetForBarSpacing(12)).toBe(3);   // 통상 분봉 뷰
    expect(peakLabelBudgetForBarSpacing(33)).toBe(8);   // 램프 끝 = MAX
  });

  it('grows monotonically with bar spacing', () => {
    const near = peakLabelBudgetForBarSpacing(6);
    const wide = peakLabelBudgetForBarSpacing(12);
    expect(wide).toBeGreaterThanOrEqual(near);
    expect(near).toBeGreaterThanOrEqual(PEAK_LABEL_BUDGET_MIN);
    expect(wide).toBeLessThanOrEqual(PEAK_LABEL_BUDGET_MAX);
  });
});

const segment = (overrides: Partial<PeakWallSegment> = {}): PeakWallSegment => ({
  time0: 1 as never,
  time1: 2 as never,
  peakTime: 1.5 as never,
  price: 23500,
  qty: 17200,
  label: '23,500, 17.2k',
  color: '#f97316',
  lineWidth: 2,
  live: false,
  ...overrides,
});

describe('live peak-wall docked label helpers', () => {
  it('extracts labels from historical segments that overlap the visible range', () => {
    const out = livePeakWallDockedLabelsFromSegments(
      [
        segment({ live: false, time0: 100 as never, time1: 200 as never, label: '24,500, 16.6k', price: 24500 }),
        segment({ live: false, time0: 250 as never, time1: 300 as never, label: '23,500, 17.2k', price: 23500 }),
      ],
      'ask',
      { from: 150 as never, to: 220 as never },
    );

    expect(out).toEqual([
      { price: 24500, label: '24,500, 16.6k', color: '#f97316', time0: 100, time1: 200, peakTime: 1.5, side: 'ask' },
    ]);
  });

  it('limits docked labels to the top visible qty ranks when requested', () => {
    const out = livePeakWallDockedLabelsFromSegments(
      [
        segment({ live: false, time0: 100 as never, time1: 200 as never, price: 100, qty: 100, label: '100, 0.1k' }),
        segment({ live: false, time0: 100 as never, time1: 200 as never, price: 101, qty: 300, label: '101, 0.3k' }),
        segment({ live: false, time0: 100 as never, time1: 200 as never, price: 102, qty: 200, label: '102, 0.2k' }),
      ],
      'ask',
      { from: 100 as never, to: 200 as never },
      2,
    );

    expect(out.map((label) => label.price)).toEqual([101, 102]);
  });

  it('emits no docked labels when the zoom budget is zero', () => {
    const out = livePeakWallDockedLabelsFromSegments(
      [
        segment({ live: false, price: 100, qty: 300, label: '0.3k' }),
        segment({ live: false, price: 101, qty: 200, label: '0.2k' }),
      ],
      'ask',
      { from: 0 as never, to: 400 as never },
      0,
    );
    expect(out).toEqual([]);
  });

  it('keeps only the top-N walls by qty when a positive budget caps them', () => {
    const out = livePeakWallDockedLabelsFromSegments(
      [
        segment({ live: false, price: 100, qty: 100, label: '0.1k' }),
        segment({ live: false, price: 101, qty: 300, label: '0.3k' }),
        segment({ live: false, price: 102, qty: 200, label: '0.2k' }),
      ],
      'ask',
      { from: 0 as never, to: 400 as never },
      2,
    );
    expect(out.map((l) => l.price).sort((a, b) => a - b)).toEqual([101, 102]);
  });

  it('treats same-price docked-label candidates as one visible wall rank', () => {
    const out = livePeakWallDockedLabelsFromSegments(
      [
        segment({ live: false, time0: 100 as never, time1: 200 as never, price: 100, qty: 300, label: '100, 0.3k' }),
        segment({ live: false, time0: 100 as never, time1: 200 as never, price: 100, qty: 250, label: '100, 0.25k' }),
        segment({ live: false, time0: 100 as never, time1: 200 as never, price: 101, qty: 200, label: '101, 0.2k' }),
      ],
      'ask',
      { from: 100 as never, to: 200 as never },
      2,
    );

    expect(out.map((label) => [label.price, label.label])).toEqual([
      [100, '100, 0.3k'],
      [101, '101, 0.2k'],
    ]);
  });

  it('keeps the largest same-price label when labels are uncapped', () => {
    const out = livePeakWallDockedLabelsFromSegments(
      [
        segment({ live: false, time0: 100 as never, time1: 200 as never, price: 100, qty: 250, label: '100, 0.25k' }),
        segment({ live: false, time0: 100 as never, time1: 200 as never, price: 100, qty: 300, label: '100, 0.3k' }),
        segment({ live: false, time0: 100 as never, time1: 200 as never, price: 101, qty: 200, label: '101, 0.2k' }),
      ],
      'ask',
      { from: 100 as never, to: 200 as never },
    );

    expect(out.map((label) => [label.price, label.label])).toEqual([
      [100, '100, 0.3k'],
      [101, '101, 0.2k'],
    ]);
  });

  it('같은 가격이라도 날이 다르면 라벨을 따로 낸다 — 앵커가 발생 분봉이라 칩이 안 겹친다', () => {
    const out = livePeakWallDockedLabelsFromSegments(
      [
        segment({ live: false, time0: 100 as never, time1: 200 as never, price: 100, qty: 300, label: 'D1 0.3k' }),
        segment({ live: false, time0: 300 as never, time1: 400 as never, price: 100, qty: 250, label: 'D2 0.25k' }),
      ],
      'ask',
      { from: 100 as never, to: 400 as never },
    );

    // 선 끝 도킹 시절에는 가격만으로 합쳐 D2 가 통째로 사라졌다(점만 남고 수량은 못 읽음).
    expect(out.map((label) => [label.time0, label.label])).toEqual([
      [100, 'D1 0.3k'],
      [300, 'D2 0.25k'],
    ]);
  });

  it('extracts labels only from live segments with visible label text', () => {
    const out = livePeakWallDockedLabelsFromSegments([
      segment({ live: false, label: '24,500, 16.6k', price: 24500, color: '#f97316' }),
      segment({ live: true, label: '23,500, 17.2k', price: 23500, color: '#ec4899' }),
      segment({ live: true, label: '', price: 23000, color: '#60a5fa' }),
    ], 'ask');

    expect(out).toEqual([
      { price: 23500, label: '23,500, 17.2k', color: '#ec4899', time0: 1, time1: 2, peakTime: 1.5, side: 'ask' },
    ]);
  });

  it('keeps live docked labels whose segment overlaps the visible range', () => {
    const out = livePeakWallDockedLabelsFromSegments(
      [segment({ live: true, time0: 100 as never, time1: 200 as never })],
      'ask',
      { from: 150 as never, to: 250 as never },
    );

    expect(out).toEqual([
      { price: 23500, label: '23,500, 17.2k', color: '#f97316', time0: 100, time1: 200, peakTime: 1.5, side: 'ask' },
    ]);
  });

  it('hides live docked labels whose segment is outside the visible range', () => {
    const out = livePeakWallDockedLabelsFromSegments(
      [segment({ live: true, time0: 100 as never, time1: 200 as never })],
      'ask',
      { from: 10 as never, to: 90 as never },
    );

    expect(out).toEqual([]);
  });

  it('keeps current behavior when the visible range is unavailable', () => {
    const out = livePeakWallDockedLabelsFromSegments(
      [segment({ live: true, time0: 100 as never, time1: 200 as never })],
      'ask',
      null,
    );

    expect(out).toEqual([
      { price: 23500, label: '23,500, 17.2k', color: '#f97316', time0: 100, time1: 200, peakTime: 1.5, side: 'ask' },
    ]);
  });

  it('removes inline label text while preserving segment geometry for docked labels', () => {
    const past = segment({ live: false, label: '24,500, 16.6k', price: 24500 });
    const live = segment({ live: true, label: '23,500, 17.2k', price: 23500 });
    const out = inlinePeakWallSegmentsForDocking([past, live]);

    expect(out[0]).toEqual({ ...past, label: '' });
    expect(out[1]).toEqual({ ...live, label: '' });
    expect(out[0]).toMatchObject({
      time0: past.time0,
      time1: past.time1,
      peakTime: past.peakTime,
      price: past.price,
      qty: past.qty,
      color: past.color,
      lineWidth: past.lineWidth,
      live: false,
    });
    expect(out[1]).toMatchObject({
      time0: live.time0,
      time1: live.time1,
      peakTime: live.peakTime,
      price: live.price,
      qty: live.qty,
      color: live.color,
      lineWidth: live.lineWidth,
      live: true,
    });
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

describe('xCoordinateOrNearest', () => {
  it('timeToCoordinate가 좌표를 주면 그대로 쓴다', () => {
    const ts = timeScaleStub({ timeToCoordinate: () => 123 });
    expect(xCoordinateOrNearest(ts, 1000 as Time)).toBe(123);
  });

  it('범위 밖 시각(null)은 가장 가까운 봉 인덱스로 클램프한다 — 통합 확장 세션 경계에서 그날 벽 선이 통째로 사라지던 결함', () => {
    const calls: unknown[][] = [];
    const ts = timeScaleStub({
      timeToCoordinate: () => null,
      timeToIndex: (...args: never[]) => {
        calls.push(args);
        return 42;
      },
      logicalToCoordinate: () => 777,
    });
    expect(xCoordinateOrNearest(ts, 1000 as Time)).toBe(777);
    // findNearest=true 로 가장 가까운 봉을 찾아야 한다(정확 일치 요구 금지).
    expect(calls[0]?.[1]).toBe(true);
  });

  it('가장 가까운 봉조차 없으면(빈 차트) null — 기존 skip 동작 유지', () => {
    const ts = timeScaleStub({});
    expect(xCoordinateOrNearest(ts, 1000 as Time)).toBeNull();
  });
});

describe('peakXFromCoordinate', () => {
  it('timeToCoordinate 가 좌표를 주면 그대로 쓴다 — 점과 라벨이 같은 x', () => {
    expect(peakXFromCoordinate(240, 15 as Time, 10 as Time, 20 as Time, 100, 300)).toBe(240);
  });

  it('로드 범위 밖(null)이면 [time0,time1] 내 위치로 선형 보간한다', () => {
    // peak 이 구간의 25% 지점 → x 도 100~300 의 25% 인 150.
    expect(peakXFromCoordinate(null, 12.5 as Time, 10 as Time, 20 as Time, 100, 300)).toBe(150);
  });

  it('보간 결과를 세그먼트 양 끝으로 클램프한다', () => {
    expect(peakXFromCoordinate(null, 99 as Time, 10 as Time, 20 as Time, 100, 300)).toBe(300);
    expect(peakXFromCoordinate(null, 1 as Time, 10 as Time, 20 as Time, 100, 300)).toBe(100);
  });

  it('폭 0 구간(time1 <= time0)은 시작점으로 떨어진다 — NaN 을 내지 않는다', () => {
    expect(peakXFromCoordinate(null, 10 as Time, 10 as Time, 10 as Time, 100, 300)).toBe(100);
  });
});

describe('peakWallChipGeometry', () => {
  const base = {
    peakX: 500,
    dayX0: 100,
    dayX1: 900,
    lineY: 200,
    textWidth: 40,
    paneWidth: 1000,
  } as const;

  it('발생 봉 x 에 칩을 중앙 정렬한다', () => {
    const geometry = peakWallChipGeometry({ ...base, side: 'ask' });
    expect(geometry).not.toBeNull();
    expect((geometry!.left + geometry!.right) / 2).toBeCloseTo(base.peakX, 6);
  });

  it('매도는 선 위, 매수는 선 아래 — 같은 분봉의 양쪽 벽이 배치 없이 갈린다', () => {
    const ask = peakWallChipGeometry({ ...base, side: 'ask' })!;
    const bid = peakWallChipGeometry({ ...base, side: 'bid' })!;
    expect(ask.bottom).toBeLessThan(base.lineY);
    expect(bid.top).toBeGreaterThan(base.lineY);
    // 점(dot)을 덮지 않도록 GAP 에 더해 dot 반지름만큼 더 띄운다.
    expect(base.lineY - ask.bottom).toBeCloseTo(LABEL_GAP_PX + PEAK_DOT_RADIUS_PX, 6);
    expect(bid.top - base.lineY).toBeCloseTo(LABEL_GAP_PX + PEAK_DOT_RADIUS_PX, 6);
  });

  it('칩이 그날 구간을 넘지 않게 가둔다 — 이웃 날 위로 새지 않는다', () => {
    const geometry = peakWallChipGeometry({
      ...base,
      side: 'ask',
      peakX: 105,
      dayX0: 100,
      dayX1: 400,
    })!;
    expect(geometry.left).toBeGreaterThanOrEqual(100);
    expect(geometry.right).toBeLessThanOrEqual(400);
  });

  it('그날 구간이 칩보다 좁으면 가두지 않는다 — 아침의 오늘 라벨이 사라지지 않게', () => {
    const geometry = peakWallChipGeometry({
      ...base,
      side: 'ask',
      peakX: 300,
      dayX0: 295,
      dayX1: 305,
    });
    expect(geometry).not.toBeNull();
    expect((geometry!.left + geometry!.right) / 2).toBeCloseTo(300, 6);
  });

  it('pane 가장자리에서는 잘리지 않게 안쪽으로 민다', () => {
    const geometry = peakWallChipGeometry({
      ...base,
      side: 'ask',
      peakX: 998,
      dayX0: 100,
      dayX1: 1000,
    })!;
    expect(geometry.right).toBeLessThanOrEqual(base.paneWidth);
  });

  it('배율을 주면 bitmap 좌표계로 그대로 확대된다 — DPR 경로와 media 경로가 같은 기하', () => {
    const media = peakWallChipGeometry({ ...base, side: 'ask' })!;
    const bitmap = peakWallChipGeometry({
      peakX: base.peakX * 2,
      dayX0: base.dayX0 * 2,
      dayX1: base.dayX1 * 2,
      lineY: base.lineY * 2,
      textWidth: base.textWidth * 2,
      paneWidth: base.paneWidth * 2,
      side: 'ask',
      horizontalScale: 2,
      verticalScale: 2,
    })!;
    expect(bitmap.left).toBeCloseTo(media.left * 2, 6);
    expect(bitmap.right).toBeCloseTo(media.right * 2, 6);
    expect(bitmap.top).toBeCloseTo(media.top * 2, 6);
    expect(bitmap.bottom).toBeCloseTo(media.bottom * 2, 6);
  });

  it('칩 rect 는 렌더러가 쓰는 xRight/baselineY 와 정확히 맞물린다', () => {
    const geometry = peakWallChipGeometry({ ...base, side: 'ask' })!;
    // 렌더러: bx = xRight - width - xPad, by = baselineY - fontHeight - yPad.
    expect(geometry.left).toBeCloseTo(geometry.xRight - base.textWidth - LABEL_BOX_X_PAD_PX, 6);
    expect(geometry.right).toBeCloseTo(geometry.xRight + LABEL_BOX_X_PAD_PX, 6);
    expect(geometry.top).toBeCloseTo(geometry.baselineY - LABEL_FONT_PX - LABEL_BOX_Y_PAD_PX, 6);
    expect(geometry.bottom).toBeCloseTo(geometry.baselineY + LABEL_BOX_Y_PAD_PX, 6);
  });

  it('좌표가 유한하지 않으면 null — 그 프레임은 라벨을 건너뛴다', () => {
    expect(peakWallChipGeometry({ ...base, side: 'ask', peakX: Number.NaN })).toBeNull();
    expect(peakWallChipGeometry({ ...base, side: 'ask', lineY: Number.POSITIVE_INFINITY })).toBeNull();
  });
});
