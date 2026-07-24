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
