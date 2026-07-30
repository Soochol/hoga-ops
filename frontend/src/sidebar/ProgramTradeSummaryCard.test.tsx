import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import ProgramTradeSummaryCard, {
  buildTimeGapSegments,
  pickProgramTradePoint,
  PROGRAM_SPARK_GAP_THRESHOLD_MS,
} from './ProgramTradeSummaryCard';
import type { ProgramTradePoint, ProgramTradeSeries } from '../api/types';

// KST 2026-07-21 09:00 기준 시각 — 날짜 클립 테스트에서 실제 달력 날짜가
// 의미를 가지므로 epoch 0 근처 대신 실전 대역을 쓴다.
const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 6, 21, 0, 0, 0); // = KST 09:00

function point(
  t: number,
  net_amount: number | null,
  opts: { net_qty?: number | null; gap_risk?: boolean } = {},
): ProgramTradePoint {
  return {
    t,
    net_qty: opts.net_qty ?? null,
    net_amount,
    gap_risk: opts.gap_risk ?? false,
  };
}

function seriesOf(points: ProgramTradePoint[]): ProgramTradeSeries {
  return { points, source: 'kis_program_trade' };
}

describe('pickProgramTradePoint', () => {
  it('returns the last point without a cursor', () => {
    const pts = [point(T0, 1), point(T0 + 1000, 2)];
    expect(pickProgramTradePoint(pts, null)?.t).toBe(T0 + 1000);
  });

  it('returns the last point at-or-before the cursor', () => {
    const pts = [point(T0, 1), point(T0 + 1000, 2), point(T0 + 2000, 3)];
    expect(pickProgramTradePoint(pts, T0 + 1500)?.t).toBe(T0 + 1000);
    expect(pickProgramTradePoint(pts, T0 + 2000)?.t).toBe(T0 + 2000);
  });

  it('returns null when the cursor precedes the first point', () => {
    const pts = [point(T0, 1)];
    expect(pickProgramTradePoint(pts, T0 - 1)).toBeNull();
  });

  it('clamps a future cursor to the latest point (no prev-day bleed)', () => {
    // 다음날 빈 영역/칸에 호버 → 전날이 아니라 최신값 고정.
    const pts = [point(T0, 1), point(T0 + 1000, 2)];
    expect(pickProgramTradePoint(pts, T0 + DAY_MS)?.t).toBe(T0 + 1000);
  });

  it('returns null when the floored point is a different day (multi-day bundle)', () => {
    // 병합 번들: 어제 마지막 + 오늘 첫 점. 커서가 오늘이지만 오늘 첫 점 이전이면
    // floor 는 어제 점 — 날짜 경계 가드가 전날 유출을 막아 null 을 낸다.
    const yesterday = point(T0 - DAY_MS + 1000, 5);
    const todayFirst = point(T0 + 1000, 10);
    const pts = [yesterday, todayFirst];
    expect(pickProgramTradePoint(pts, T0)).toBeNull();
    // 같은 날 안에서는 정상 floor.
    expect(pickProgramTradePoint(pts, T0 + 2000)?.t).toBe(T0 + 1000);
  });

  describe('todayKst 오늘 스코프 (거래원식 latest 리셋)', () => {
    // 마지막 점은 T0 의 날(20260721). "다음날 아침" = todayKst 를 하루 뒤로.
    const pts = [point(T0, 1), point(T0 + 1000, 2)];
    const LAST_DAY = '20260721';
    const NEXT_DAY = '20260722';

    it('keeps the last point in latest mode when it is from today', () => {
      expect(pickProgramTradePoint(pts, null, LAST_DAY)?.t).toBe(T0 + 1000);
    });

    it('returns null in latest mode when the last point is from a previous day', () => {
      // 새날 아침(오늘 관측 0건): 전일 마감 누적이 현재값처럼 남지 않는다.
      expect(pickProgramTradePoint(pts, null, NEXT_DAY)).toBeNull();
    });

    it('still floors to a past day under an explicit cursor (hover unaffected)', () => {
      // 오늘 스코프는 latest 전용 — 차트 크로스헤어로 전일을 짚으면 그대로 나온다.
      expect(pickProgramTradePoint(pts, T0 + 500, NEXT_DAY)?.t).toBe(T0);
    });

    it('keeps the same-day future clamp regardless of todayKst', () => {
      // 전일 뷰에서 마지막 관측 이후(그 날 마감 후) 호버 — 그 날 마지막 값 고정.
      expect(pickProgramTradePoint(pts, T0 + 2000, NEXT_DAY)?.t).toBe(T0 + 1000);
    });

    it('blocks the cross-day future clamp when the last point is not today', () => {
      // 커서가 오늘(다음날) 칸인데 마지막 점은 전일 — 클램프 경로로도 전일이
      // 새지 않는다(latest 와 같은 오늘 스코프).
      expect(pickProgramTradePoint(pts, T0 + DAY_MS, NEXT_DAY)).toBeNull();
    });

    it('leaves the cross-day clamp intact without todayKst (/study semantics)', () => {
      expect(pickProgramTradePoint(pts, T0 + DAY_MS, null)?.t).toBe(T0 + 1000);
    });
  });
});

describe('buildTimeGapSegments', () => {
  it('keeps points within the threshold as one solid run', () => {
    const pts = [
      { t: 0, v: 1 },
      { t: 30_000, v: 2 },
      { t: 60_000, v: 3 },
    ];
    expect(buildTimeGapSegments(pts, 90_000)).toEqual([{ kind: 'solid', pts }]);
  });

  it('emits a 2-point dashed bridge across a gap beyond the threshold', () => {
    const pts = [
      { t: 0, v: 1 },
      { t: 30_000, v: 2 },
      { t: 300_000, v: 3 },
      { t: 330_000, v: 4 },
    ];
    const segs = buildTimeGapSegments(pts, 90_000);
    expect(segs.map((s) => s.kind)).toEqual(['solid', 'dashed', 'solid']);
    expect(segs[1].pts).toEqual([pts[1], pts[2]]);
    // 새 solid run 은 갭 뒤 점에서 다시 시작한다 (선이 끊기지 않게).
    expect(segs[2].pts).toEqual([pts[2], pts[3]]);
  });

  it('handles a single point without emitting a bridge', () => {
    const pts = [{ t: 0, v: 1 }];
    expect(buildTimeGapSegments(pts, 90_000)).toEqual([{ kind: 'solid', pts }]);
  });
});

describe('ProgramTradeSummaryCard — render states', () => {
  it('shows empty state without a series', () => {
    render(<ProgramTradeSummaryCard series={null} />);
    expect(screen.getByText(/프로그램 순매수 데이터 없음/)).toBeInTheDocument();
  });

  it('renders amount/qty of the cursor-picked point', () => {
    const series = seriesOf([
      point(T0, 100_000_000, { net_qty: 10 }),
      point(T0 + 1000, 200_000_000, { net_qty: 20 }),
    ]);
    render(<ProgramTradeSummaryCard series={series} cursorMs={T0 + 500} />);
    // 커서 → 첫 point (1억).
    expect(screen.getByText('+1억')).toBeInTheDocument();
    expect(screen.getByText('+10')).toBeInTheDocument();
  });

  it('shows empty state in latest mode when the series has no today point', () => {
    // 새날 아침: 번들엔 전일 시리즈만 있다 — 전일 마감 누적(15:29 값)이 현재값처럼
    // 렌더되지 않고 거래원 창("거래원 정보 없음")과 같은 빈 상태로 리셋된다.
    const series = seriesOf([point(T0, 100_000_000), point(T0 + 1000, 200_000_000)]);
    render(<ProgramTradeSummaryCard series={series} todayKst="20260722" />);
    expect(screen.getByText(/프로그램 순매수 데이터 없음/)).toBeInTheDocument();
    expect(screen.queryByTestId('program-sparkline')).toBeNull();
  });

  it('renders normally in latest mode when the last point is from today', () => {
    const series = seriesOf([point(T0, 100_000_000, { net_qty: 10 })]);
    render(<ProgramTradeSummaryCard series={series} todayKst="20260721" />);
    expect(screen.getByText('+1억')).toBeInTheDocument();
  });

  it('shows the 보간 label only when the picked point has gap_risk', () => {
    const series = seriesOf([
      point(T0, 1, { gap_risk: false }),
      point(T0 + 1000, 2, { gap_risk: true }),
    ]);
    render(<ProgramTradeSummaryCard series={series} />);
    expect(screen.getByText(/일부 구간 보간/)).toBeInTheDocument();
  });
});

describe('ProgramTradeSummaryCard — sparkline', () => {
  it('draws a solid polyline and zero baseline for a 2+ point series', () => {
    const series = seriesOf([point(T0, 1), point(T0 + 30_000, 2)]);
    render(<ProgramTradeSummaryCard series={series} />);
    expect(screen.getByTestId('program-sparkline')).toBeInTheDocument();
    expect(screen.getByTestId('zero-baseline')).toBeInTheDocument();
    expect(screen.getAllByTestId('sparkline-solid')).toHaveLength(1);
    expect(screen.queryByTestId('sparkline-dashed')).toBeNull();
  });

  it('has no price overlay without closePoints (default unchanged)', () => {
    const series = seriesOf([point(T0, 1), point(T0 + 30_000, 2)]);
    render(<ProgramTradeSummaryCard series={series} />);
    expect(screen.queryByTestId('program-price-graph')).toBeNull();
  });

  it('overlays the same-day close curve when closePoints are given', () => {
    const series = seriesOf([point(T0, 1), point(T0 + 60_000, 3)]);
    render(
      <ProgramTradeSummaryCard
        series={series}
        closePoints={[
          { t_ms: T0, close: 70_000 },
          { t_ms: T0 + 60_000, close: 70_500 },
        ]}
      />,
    );
    const price = screen.getByTestId('program-price-graph');
    // 참조선은 dim 회색(순매수 accent 와 구분) — 데이터 라인이 아닌 보조선.
    expect(price.getAttribute('stroke')).toBe('var(--fg-dim)');
    expect(price.getAttribute('points')?.split(' ')).toHaveLength(2);
  });

  it('clips the close overlay to the sparkline day (drops other-day closes)', () => {
    const series = seriesOf([point(T0, 1), point(T0 + 60_000, 3)]);
    render(
      <ProgramTradeSummaryCard
        series={series}
        closePoints={[
          { t_ms: T0 - DAY_MS, close: 60_000 }, // 전날 — 제외
          { t_ms: T0, close: 70_000 },
          { t_ms: T0 + 60_000, close: 70_500 },
        ]}
      />,
    );
    // 당일 2점만 그린다 — 전날 종가는 축을 오염시키지 않는다.
    expect(
      screen.getByTestId('program-price-graph').getAttribute('points')?.split(' '),
    ).toHaveLength(2);
  });

  it('skips the overlay when only one same-day close exists (needs 2+)', () => {
    const series = seriesOf([point(T0, 1), point(T0 + 60_000, 3)]);
    render(
      <ProgramTradeSummaryCard
        series={series}
        closePoints={[{ t_ms: T0, close: 70_000 }]}
      />,
    );
    expect(screen.queryByTestId('program-price-graph')).toBeNull();
  });

  it('draws a dashed bridge across an observation gap', () => {
    const series = seriesOf([
      point(T0, 1),
      point(T0 + 30_000, 2),
      point(T0 + 30_000 + PROGRAM_SPARK_GAP_THRESHOLD_MS + 1, 3),
    ]);
    render(<ProgramTradeSummaryCard series={series} />);
    expect(screen.getAllByTestId('sparkline-dashed')).toHaveLength(1);
  });

  it('clips to the picked point day when the merged series spans days', () => {
    const series = seriesOf([
      point(T0 - DAY_MS, 5),
      point(T0 - DAY_MS + 30_000, 6),
      point(T0, 1),
      point(T0 + 30_000, 2),
      point(T0 + 60_000, 3),
    ]);
    render(<ProgramTradeSummaryCard series={series} />);
    const solid = screen.getAllByTestId('sparkline-solid');
    expect(solid).toHaveLength(1);
    // 마지막 point 의 날(오늘) 3점만 그린다 — 전날 2점은 제외.
    expect(solid[0].getAttribute('points')?.split(' ')).toHaveLength(3);
  });

  it('draws the cursor day curve when the cursor picks a previous day', () => {
    const series = seriesOf([
      point(T0 - DAY_MS, 5),
      point(T0 - DAY_MS + 30_000, 6),
      point(T0, 1),
      point(T0 + 30_000, 2),
    ]);
    render(<ProgramTradeSummaryCard series={series} cursorMs={T0 - DAY_MS + 40_000} />);
    const solid = screen.getAllByTestId('sparkline-solid');
    expect(solid).toHaveLength(1);
    // 커서가 고른 point 의 날(전날) 2점만 그린다.
    expect(solid[0].getAttribute('points')?.split(' ')).toHaveLength(2);
  });

  it('skips null net_amount points without breaking the line', () => {
    const series = seriesOf([
      point(T0, 1),
      point(T0 + 30_000, null),
      point(T0 + 60_000, 3),
    ]);
    render(<ProgramTradeSummaryCard series={series} />);
    const solid = screen.getAllByTestId('sparkline-solid');
    expect(solid).toHaveLength(1);
    // null point 는 좌표에서 제외 — 정점은 2개뿐이다.
    expect(solid[0].getAttribute('points')?.split(' ')).toHaveLength(2);
  });

  it('renders no svg with fewer than 2 drawable points', () => {
    const series = seriesOf([point(T0, 1), point(T0 + 30_000, null)]);
    render(<ProgramTradeSummaryCard series={series} />);
    expect(screen.queryByTestId('program-sparkline')).toBeNull();
    expect(screen.queryByTestId('zero-baseline')).toBeNull();
  });

  it('labels the y-axis with the domain bounds', () => {
    const series = seriesOf([point(T0, 0), point(T0 + 30_000, 500_000_000_000)]);
    render(<ProgramTradeSummaryCard series={series} />);
    // 도메인은 0을 항상 포함 — 전량 양수 날이면 하한 라벨이 0억이 된다.
    expect(screen.getByTestId('axis-label-max')).toHaveTextContent('5,000억');
    expect(screen.getByTestId('axis-label-min')).toHaveTextContent('0억');
  });

  it('labels a negative domain bound with its sign', () => {
    const series = seriesOf([point(T0, 0), point(T0 + 30_000, -200_000_000_000)]);
    render(<ProgramTradeSummaryCard series={series} />);
    expect(screen.getByTestId('axis-label-max')).toHaveTextContent('0억');
    expect(screen.getByTestId('axis-label-min')).toHaveTextContent('-2,000억');
  });

  it('adds a zero-line label only when zero sits mid-domain', () => {
    // 대칭 교차일 — 0선이 정확히 중앙(50%)이라 상·하한 라벨과 안 겹친다.
    const straddling = seriesOf([
      point(T0, 100_000_000_000),
      point(T0 + 30_000, -100_000_000_000),
    ]);
    const { rerender } = render(<ProgramTradeSummaryCard series={straddling} />);
    expect(screen.getByTestId('axis-label-zero')).toHaveTextContent('0억');

    // 단일 부호 날은 하한 라벨이 이미 0억이므로 중복 라벨을 달지 않는다.
    rerender(
      <ProgramTradeSummaryCard
        series={seriesOf([point(T0, 0), point(T0 + 30_000, 100_000_000_000)])}
      />,
    );
    expect(screen.queryByTestId('axis-label-zero')).toBeNull();
  });

  it('omits the zero-line label when it would collide with a bound label', () => {
    // 0선이 상단 근처(도메인의 ~9%) — 상한 라벨과 겹치므로 생략한다.
    const skewed = seriesOf([
      point(T0, 10_000_000_000),
      point(T0 + 30_000, -100_000_000_000),
    ]);
    render(<ProgramTradeSummaryCard series={skewed} />);
    expect(screen.queryByTestId('axis-label-zero')).toBeNull();
  });

  it('renders no axis labels without a drawable series', () => {
    const series = seriesOf([point(T0, 1), point(T0 + 30_000, null)]);
    render(<ProgramTradeSummaryCard series={series} />);
    expect(screen.queryByTestId('program-sparkline-axis')).toBeNull();
    expect(screen.queryByTestId('axis-label-max')).toBeNull();
  });

  it('shows cursor marker and value dot when the cursor is inside the drawn range', () => {
    const series = seriesOf([point(T0, 1), point(T0 + 60_000, 3)]);
    render(<ProgramTradeSummaryCard series={series} cursorMs={T0 + 30_000} />);
    expect(screen.getByTestId('cursor-marker')).toBeInTheDocument();
    expect(screen.getByTestId('cursor-value-dot')).toBeInTheDocument();
  });

  it('draws a dashed gray vertical cursor line (not an accent line)', () => {
    const series = seriesOf([point(T0, 1), point(T0 + 60_000, 3)]);
    render(<ProgramTradeSummaryCard series={series} cursorMs={T0 + 30_000} />);
    const vline = screen.getByTestId('cursor-marker');
    // 가는 회색 점선(accent 아님) — 데이터 라인과 톤·질감 모두로 분리한다.
    expect(vline.getAttribute('stroke')).toBe('var(--fg-dimmer)');
    expect(vline.getAttribute('stroke-dasharray')).toBe('3,3');
  });

  it('does not draw the horizontal line or value badge without mouse-Y hover', () => {
    // 가로선·값 배지는 마우스 Y 를 읽는다(곡선 스냅 아님). cursorMs 주입만으론
    // 세로선만 뜨고 — 마우스가 이 스파크라인 위에 있어야 가로선·배지가 뜬다.
    // (jsdom 은 getBoundingClientRect 를 0 으로 줘 호버 Y 를 만들 수 없다;
    //  Y→값 환산은 valueFromYRatio 단위 테스트로 고정한다.)
    const series = seriesOf([point(T0, 1), point(T0 + 60_000, 3)]);
    render(<ProgramTradeSummaryCard series={series} cursorMs={T0 + 30_000} />);
    expect(screen.getByTestId('cursor-marker')).toBeInTheDocument();
    expect(screen.queryByTestId('cursor-hline')).toBeNull();
    expect(screen.queryByTestId('axis-label-cursor')).toBeNull();
  });

  it('hides cursor marker without a cursor or outside the drawn range', () => {
    const series = seriesOf([point(T0, 1), point(T0 + 60_000, 3)]);
    const { rerender } = render(
      <ProgramTradeSummaryCard series={series} cursorMs={null} />,
    );
    expect(screen.queryByTestId('cursor-marker')).toBeNull();
    // 커서가 마지막 관측 이후: 카드 숫자는 마지막 point 를 표시하지만
    // 그래프 위 도트/마커는 그려진 궤적 범위 밖이므로 숨긴다.
    rerender(<ProgramTradeSummaryCard series={series} cursorMs={T0 + DAY_MS} />);
    expect(screen.queryByTestId('cursor-marker')).toBeNull();
    expect(screen.queryByTestId('cursor-value-dot')).toBeNull();
  });
});

describe('ProgramTradeSummaryCard — 시간축', () => {
  it('labels the x-axis with the domain start/mid/end in KST', () => {
    // T0 = KST 09:00. 60분 궤적이면 09:00 / 09:30 / 10:00.
    const series = seriesOf([point(T0, 1), point(T0 + 60 * 60_000, 2)]);
    render(<ProgramTradeSummaryCard series={series} />);
    const axis = screen.getByTestId('program-sparkline-time-axis');
    expect(axis).toHaveTextContent('09:00');
    expect(axis).toHaveTextContent('09:30');
    expect(axis).toHaveTextContent('10:00');
  });

  it('widens the labels to the union range when the close overlay starts earlier', () => {
    // 축 도메인은 순매수·가격 통합 범위(geometry 의 tFirst/tLast)다. 가격이 09:00 부터
    // 있고 순매수가 09:30 부터면 좌측 라벨은 09:00 — 라벨과 곡선이 같은 축을 읽는다.
    const series = seriesOf([point(T0 + 30 * 60_000, 1), point(T0 + 60 * 60_000, 2)]);
    render(
      <ProgramTradeSummaryCard
        series={series}
        closePoints={[
          { t_ms: T0, close: 70_000 },
          { t_ms: T0 + 60 * 60_000, close: 70_500 },
        ]}
      />,
    );
    const axis = screen.getByTestId('program-sparkline-time-axis');
    expect(axis).toHaveTextContent('09:00');
    expect(axis).toHaveTextContent('10:00');
  });

  it('ends the axis at the last close, not at a later net-buy observation', () => {
    // 매물대 카드의 axisEndMs = 종가 라인 마지막 점(= 마지막 봉 ts_ms). 프로그램은
    // 30초 주기 실시간 꼬리가 그보다 늦게 찍히는데, 그걸로 축을 늘리면 두 창의
    // 우측 끝이 최대 1봉 어긋난다. 순매수 마지막이 10:30 이어도 축 끝은 10:00.
    const series = seriesOf([
      point(T0 + 58 * 60_000, 1),
      point(T0 + 59 * 60_000, 2),
      point(T0 + 90 * 60_000, 3),
    ]);
    render(
      <ProgramTradeSummaryCard
        series={series}
        closePoints={[
          { t_ms: T0, close: 70_000 },
          { t_ms: T0 + 60 * 60_000, close: 70_500 },
        ]}
      />,
    );
    const axis = screen.getByTestId('program-sparkline-time-axis');
    expect(axis).toHaveTextContent('09:00');
    expect(axis).toHaveTextContent('09:30');
    expect(axis).toHaveTextContent('10:00');
    // 순매수 마지막(10:30)이 축을 늘렸다면 중간 라벨이 09:45 였을 것이다.
    expect(axis).not.toHaveTextContent('10:30');
  });

  it('clamps a past-the-end net-buy point to x=100 instead of dropping it', () => {
    // 축 끝을 넘는 실시간 꼬리는 버리지 않는다 — 최신값이 곡선에서 사라지면
    // "지금 프로그램이 들어오는 중" 을 읽을 수 없다. 가격선의 마지막 점과 순매수의
    // 마지막 점이 **둘 다** x=100 이면 축 끝이 가격(= 매물대 기준)에 맞은 것이다.
    const series = seriesOf([
      point(T0 + 59 * 60_000, 1),
      point(T0 + 59 * 60_000 + 30_000, 2),
      point(T0 + 60 * 60_000 + 30_000, 3), // 축 끝(10:00) 이후 = 10:00:30
    ]);
    render(
      <ProgramTradeSummaryCard
        series={series}
        closePoints={[
          { t_ms: T0, close: 70_000 },
          { t_ms: T0 + 60 * 60_000, close: 70_500 },
        ]}
      />,
    );
    const lastX = (testId: string) => {
      const pts = screen.getByTestId(testId).getAttribute('points')?.split(' ') ?? [];
      return pts[pts.length - 1]?.split(',')[0];
    };
    expect(lastX('program-price-graph')).toBe('100');
    expect(lastX('sparkline-solid')).toBe('100');
    // 점은 유지된다 — 3점 궤적이 2점으로 줄지 않았다.
    expect(
      screen.getByTestId('sparkline-solid').getAttribute('points')?.split(' '),
    ).toHaveLength(3);
  });

  it('falls back to the last net-buy observation without a close overlay', () => {
    // 맞출 대상(가격선)이 없으면 축 끝은 순매수 마지막 관측이다 — 곡선이 x=100 까지
    // 온전히 뻗는다. (갭 임계 이내 간격이라 solid 한 줄로 남는다.)
    const series = seriesOf([point(T0, 1), point(T0 + 60_000, 2), point(T0 + 120_000, 3)]);
    render(<ProgramTradeSummaryCard series={series} />);
    expect(screen.getByTestId('program-sparkline-time-axis')).toHaveTextContent('09:02');
    const pts = screen.getByTestId('sparkline-solid').getAttribute('points')?.split(' ') ?? [];
    expect(pts[pts.length - 1]?.split(',')[0]).toBe('100');
  });

  it('renders no time axis without a drawable series', () => {
    // 금액축과 같은 규칙 — 그릴 궤적이 없으면 축도 없다(빈 눈금만 남지 않게).
    const series = seriesOf([point(T0, 1), point(T0 + 30_000, null)]);
    render(<ProgramTradeSummaryCard series={series} />);
    expect(screen.queryByTestId('program-sparkline-time-axis')).toBeNull();
  });
});

describe('ProgramTradeSummaryCard — 커서가 순매수 첫 관측보다 앞선 구간', () => {
  // 축이 가격 오버레이까지 담아 넓어지면 도메인 앞쪽에 "순매수 관측이 아직 없는"
  // 구간이 생긴다. 예전엔 그 구간 호버가 카드 전체를 빈 상태로 무너뜨리고,
  // 스파크라인이 언마운트돼 onMouseLeave 가 걸릴 대상까지 사라져 상태가 고착됐다.
  // 순매수는 09:30 부터 30초 간격 2점(갭 임계 이내라 solid 한 줄), 가격은 09:00~10:00.
  // → 축 도메인 09:00~10:00 이고 그 앞쪽 30분에는 순매수 관측이 없다.
  const series = seriesOf([
    point(T0 + 30 * 60_000, 100_000_000, { net_qty: 10 }),
    point(T0 + 30 * 60_000 + 30_000, 200_000_000, { net_qty: 20 }),
  ]);
  const closePoints = [
    { t_ms: T0, close: 70_000 },
    { t_ms: T0 + 60 * 60_000, close: 70_500 },
  ];

  it('keeps the sparkline and axes instead of collapsing to the empty state', () => {
    render(
      <ProgramTradeSummaryCard
        series={series}
        closePoints={closePoints}
        cursorMs={T0 + 5 * 60_000}
        todayKst="20260721"
      />,
    );
    expect(screen.queryByText(/프로그램 순매수 데이터 없음/)).toBeNull();
    expect(screen.getByTestId('program-sparkline')).toBeInTheDocument();
    expect(screen.getByTestId('program-sparkline-time-axis')).toBeInTheDocument();
    expect(screen.getAllByTestId('sparkline-solid')).toHaveLength(1);
  });

  it('blanks the amount/qty and shows the cursor clock', () => {
    render(
      <ProgramTradeSummaryCard
        series={series}
        closePoints={closePoints}
        cursorMs={T0 + 5 * 60_000}
        todayKst="20260721"
      />,
    );
    // 숫자는 대시 — 그 시각에 관측이 없다는 뜻이다(0 으로 채우면 "순매수 0" 이라는
    // 없는 관측을 만들어낸다). 시각은 커서 위치를 그대로 읽어준다.
    expect(screen.getAllByText('-')).toHaveLength(2);
    expect(screen.getByText('09:05:00')).toBeInTheDocument();
    expect(screen.queryByText('+1억')).toBeNull();
  });

  it('still shows the empty state when the series itself has no today point', () => {
    // 새날 아침(ADR-0044 오늘 스코프): 전일 시리즈만 있고 커서도 없으면 빈 상태.
    render(
      <ProgramTradeSummaryCard series={series} closePoints={closePoints} todayKst="20260722" />,
    );
    expect(screen.getByText(/프로그램 순매수 데이터 없음/)).toBeInTheDocument();
    expect(screen.queryByTestId('program-sparkline')).toBeNull();
  });

  it('keeps the prev-day hover readable under a today scope', () => {
    // 오늘 스코프여도 커서가 전일을 가리키면 그 날 값을 읽는다 — 빈 상태 판정을
    // latest 하나로 좁히면 이 경로가 함께 죽는다. 커서(09:45)가 그 날 마지막 관측
    // 이후이므로 같은 날 미래 클램프가 걸려 마지막 값(+2억)을 표시한다.
    render(
      <ProgramTradeSummaryCard
        series={series}
        cursorMs={T0 + 45 * 60_000}
        todayKst="20260722"
      />,
    );
    expect(screen.queryByText(/프로그램 순매수 데이터 없음/)).toBeNull();
    expect(screen.getByText('+2억')).toBeInTheDocument();
  });
});
