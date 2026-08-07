import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import BrokerTrajectoryTable, {
  netAtCursor,
  GAP_THRESHOLD_MS,
} from './BrokerTrajectoryTable';
import type { BrokerSeriesEntry } from '../api/types';

function entry(
  broker: string,
  points: { ts_ms: number; net: number }[],
  side: 'buy' | 'sell' = 'buy',
): BrokerSeriesEntry {
  const final_net = points.length ? points[points.length - 1].net : 0;
  return { broker, final_net, dominant_side: side, points };
}

describe('netAtCursor', () => {
  it('returns null when cursorMs is null', () => {
    const e = entry('A', [{ ts_ms: 100, net: 5 }]);
    expect(netAtCursor(e, null)).toBeNull();
  });

  it('returns null when cursor precedes broker first observation (아직 등장 전)', () => {
    const e = entry('A', [{ ts_ms: 200, net: 5 }]);
    expect(netAtCursor(e, 100)).toBeNull();
  });

  it('returns the net of the last point at-or-before cursor', () => {
    const e = entry('A', [
      { ts_ms: 100, net: 5 },
      { ts_ms: 200, net: 10 },
      { ts_ms: 300, net: 15 },
    ]);
    expect(netAtCursor(e, 250)).toBe(10);
    expect(netAtCursor(e, 300)).toBe(15);
    expect(netAtCursor(e, 999)).toBe(15);
  });

  it('returns the exact point net when cursor lands on a ts', () => {
    const e = entry('A', [
      { ts_ms: 100, net: 5 },
      { ts_ms: 200, net: 10 },
    ]);
    expect(netAtCursor(e, 100)).toBe(5);
    expect(netAtCursor(e, 200)).toBe(10);
  });

  it('handles single-point series', () => {
    const e = entry('A', [{ ts_ms: 100, net: 5 }]);
    expect(netAtCursor(e, 50)).toBeNull();
    expect(netAtCursor(e, 100)).toBe(5);
    expect(netAtCursor(e, 200)).toBe(5);
  });
});

describe('BrokerTrajectoryTable — render states', () => {
  it('shows loading text when series is undefined', () => {
    render(<BrokerTrajectoryTable series={undefined} cursorMs={null} venue="KRX" />);
    expect(screen.getByText(/커서 위치 불러오는 중/)).toBeInTheDocument();
  });

  it('shows empty text when series is null', () => {
    render(<BrokerTrajectoryTable series={null} cursorMs={null} venue="KRX" />);
    expect(screen.getByText(/거래원 정보 없음/)).toBeInTheDocument();
  });

  it('shows empty text when series is []', () => {
    render(<BrokerTrajectoryTable series={[]} cursorMs={null} venue="KRX" />);
    expect(screen.getByText(/거래원 정보 없음/)).toBeInTheDocument();
  });

  it('renders more than ten broker rows', () => {
    const series: BrokerSeriesEntry[] = Array.from({ length: 12 }, (_, i) =>
      entry(`B${i}`, [{ ts_ms: 100 + i, net: 100 - i }]),
    );
    render(<BrokerTrajectoryTable series={series} cursorMs={null} venue="KRX" />);
    expect(screen.getAllByTestId('broker-row')).toHaveLength(12);
  });

  it('renders the compact display label and exposes the canonical name as a tooltip', () => {
    const series: BrokerSeriesEntry[] = [
      entry('신한투자증권', [{ ts_ms: 100, net: -100 }]),
    ];
    render(<BrokerTrajectoryTable series={series} cursorMs={null} venue="KRX" />);
    // Compact label visible in the row.
    expect(screen.getByText('신한투자')).toBeInTheDocument();
    // Canonical name accessible via title attribute for disambiguation.
    expect(screen.getByTitle('신한투자증권')).toBeInTheDocument();
  });
});

describe('BrokerTrajectoryTable — sparkline', () => {
  // 2026-06-25 KST. KRX 정규장 09:00~15:30 · 확장(NXT·UN) 08:00~20:00.
  const OPEN = Date.UTC(2026, 5, 25, 0, 0, 0);
  const CLOSE = OPEN + 6.5 * 3600_000;
  const AFTER_CLOSE = CLOSE + 60 * 60_000; // 16:30 — 애프터마켓
  const PRE_OPEN = OPEN - 59 * 60_000; // 08:01 — 프리마켓

  it('KRX 선택은 마감 후 점을 정규장 x 도메인으로 계속 자른다(#245 원 목적 보존)', () => {
    const series: BrokerSeriesEntry[] = [
      entry('A', [
        { ts_ms: OPEN, net: 10 },
        { ts_ms: CLOSE, net: 20 },
        { ts_ms: AFTER_CLOSE, net: 999 },
      ]),
    ];
    const { container } = render(
      <BrokerTrajectoryTable series={series} cursorMs={AFTER_CLOSE} venue="KRX" />,
    );

    const points = Array.from(container.querySelectorAll('polyline')).map((line) =>
      line.getAttribute('points'),
    );
    expect(points).toContain('0,8 60,0');
    expect(screen.getByText('+20')).toBeInTheDocument();
    // 커서(16:30)가 15:30 축 밖 — KRX 에서는 마커가 없는 것이 맞다.
    expect(container.querySelector('[data-testid="cursor-marker"]')).toBeNull();
  });

  // ↑↓ 같은 입력에 정반대 기댓값. venue 만으로 갈리므로 클립이 실제로 venue 를
  // 보는지에 대한 판별자다(둘 다 통과하는 구현은 하나뿐).
  it('확장 venue(UN)는 애프터마켓 점을 살리고 x 축을 20:00 까지 연다', () => {
    const series: BrokerSeriesEntry[] = [
      entry('A', [
        { ts_ms: OPEN, net: 10 },
        { ts_ms: CLOSE, net: 20 },
        { ts_ms: AFTER_CLOSE, net: 999 },
      ]),
    ];
    const { container } = render(
      <BrokerTrajectoryTable series={series} cursorMs={AFTER_CLOSE} venue="UN" />,
    );

    // 애프터마켓 값이 표시된다 — 예전엔 클립돼 15:30 의 +20 에서 멎었다.
    expect(screen.getByText('+999')).toBeInTheDocument();
    // 커서(16:30)가 08:00–20:00 축 안 — 마커가 그려져야 한다.
    expect(container.querySelector('[data-testid="cursor-marker"]')).not.toBeNull();
  });

  it('확장 venue(NXT)는 프리마켓 점을 살린다', () => {
    const series: BrokerSeriesEntry[] = [
      entry('A', [
        { ts_ms: PRE_OPEN, net: 5 },
        { ts_ms: OPEN + 30 * 60_000, net: 40 },
      ]),
    ];
    render(
      <BrokerTrajectoryTable series={series} cursorMs={PRE_OPEN} venue="NXT" />,
    );
    expect(screen.getByText('+5')).toBeInTheDocument();
  });

  it('KRX 선택은 프리마켓 점을 잘라 커서 시점이 관측 전으로 남는다', () => {
    const series: BrokerSeriesEntry[] = [
      entry('A', [
        { ts_ms: PRE_OPEN, net: 5 },
        { ts_ms: OPEN + 30 * 60_000, net: 40 },
      ]),
    ];
    render(
      <BrokerTrajectoryTable series={series} cursorMs={PRE_OPEN} venue="KRX" />,
    );
    // 08:01 점이 없으니 그 시각은 "아직 등장 전" — 진짜 0 과 구분되는 —.
    expect(screen.getByTestId('broker-net-preobs')).toBeInTheDocument();
  });

  it('renders a dashed polyline when a gap exceeds GAP_THRESHOLD_MS', () => {
    const big_gap = GAP_THRESHOLD_MS + 1;
    const series: BrokerSeriesEntry[] = [
      entry('A', [
        { ts_ms: 0, net: 10 },
        { ts_ms: big_gap, net: 50 },     // gap → dashed
        { ts_ms: big_gap + 1_000, net: 60 },
      ]),
    ];
    const { container } = render(
      <BrokerTrajectoryTable series={series} cursorMs={null} venue="KRX" />,
    );
    const dashed = container.querySelectorAll('polyline[stroke-dasharray]');
    expect(dashed.length).toBeGreaterThanOrEqual(1);
  });

  it('keeps dashed gap segments as vivid as solid broker trajectory segments', () => {
    const big_gap = GAP_THRESHOLD_MS + 1;
    const series: BrokerSeriesEntry[] = [
      entry('A', [
        { ts_ms: 0, net: 10 },
        { ts_ms: big_gap, net: 50 },
      ]),
    ];
    const { container } = render(
      <BrokerTrajectoryTable series={series} cursorMs={null} venue="KRX" />,
    );

    const dashed = container.querySelector('polyline[stroke-dasharray]');
    expect(dashed).not.toBeNull();
    expect(dashed).toHaveAttribute('stroke', 'var(--price-up)');
    expect(dashed).not.toHaveAttribute('opacity');
  });

  it('does NOT render the cursor marker when cursorMs lies outside the day range', () => {
    const series: BrokerSeriesEntry[] = [
      entry('A', [
        { ts_ms: 1_000, net: 10 },
        { ts_ms: 5_000, net: 20 },
      ]),
    ];
    const { container } = render(
      <BrokerTrajectoryTable series={series} cursorMs={-500} venue="KRX" />,    // before regular-session open
    );
    const cursorLines = container.querySelectorAll('[data-testid="cursor-marker"]');
    expect(cursorLines.length).toBe(0);
  });

  it('renders the cursor marker when cursorMs is inside the day range', () => {
    const series: BrokerSeriesEntry[] = [
      entry('A', [
        { ts_ms: 1_000, net: 10 },
        { ts_ms: 5_000, net: 20 },
      ]),
    ];
    const { container } = render(
      <BrokerTrajectoryTable series={series} cursorMs={3_000} venue="KRX" />,
    );
    const cursorLines = container.querySelectorAll('[data-testid="cursor-marker"]');
    expect(cursorLines.length).toBeGreaterThanOrEqual(1);
  });

  it('hides only the crosshair (not the net values) while pointer is inside off the sparklines', () => {
    // "구분선 우측 점프" + 그 회귀("순매수 전부 —") 동시 방지. 마우스가 창 안
    // (스파크라인 밖 divider·여백)이면 크로스헤어(세로선)는 숨기되, 순매수 열은
    // latest(cursorMs)로 값을 유지한다 — 두 커서(marker/net)를 분리했기 때문.
    const series: BrokerSeriesEntry[] = [
      entry('A', [
        { ts_ms: 1_000, net: 10 },
        { ts_ms: 5_000, net: 20 },
      ]),
    ];
    const { container } = render(
      <BrokerTrajectoryTable series={series} cursorMs={3_000} venue="KRX" />,
    );
    const root = container.firstElementChild as HTMLElement;
    // 창 밖(초기): 외부 크로스헤어 존중 + 순매수 값 표시.
    expect(container.querySelectorAll('[data-testid="cursor-marker"]').length).toBeGreaterThan(0);
    expect(screen.getByText('+10')).toBeInTheDocument();
    // 포인터가 창 안으로: 크로스헤어는 숨지만(우측 점프 방지) 순매수는 그대로 유지.
    fireEvent.mouseEnter(root);
    expect(container.querySelectorAll('[data-testid="cursor-marker"]').length).toBe(0);
    expect(container.querySelector('[data-testid="broker-net-preobs"]')).toBeNull();
    expect(screen.getByText('+10')).toBeInTheDocument();
    // 창을 벗어나면 다시 외부 크로스헤어를 존중한다.
    fireEvent.mouseLeave(root);
    expect(container.querySelectorAll('[data-testid="cursor-marker"]').length).toBeGreaterThan(0);
  });

  it('draws the cursor marker as a dashed gray line (not accent)', () => {
    const series: BrokerSeriesEntry[] = [
      entry('A', [
        { ts_ms: 1_000, net: 10 },
        { ts_ms: 5_000, net: 20 },
      ]),
    ];
    const { container } = render(
      <BrokerTrajectoryTable series={series} cursorMs={3_000} venue="KRX" />,
    );
    const marker = container.querySelector('[data-testid="cursor-marker"]');
    // 가는 회색 점선 — accent 가 아니라 회색 톤으로 데이터 라인과 분리.
    expect(marker).toHaveAttribute('stroke', 'var(--fg-dimmer)');
    expect(marker).toHaveAttribute('stroke-dasharray', '3,3');
  });

  it('uses all rendered brokers when computing the visible day range', () => {
    const series: BrokerSeriesEntry[] = [
      ...Array.from({ length: 12 }, (_, i) =>
        entry(`B${i}`, [
          { ts_ms: 1_000, net: 10 + i },
          { ts_ms: 2_000, net: 20 + i },
        ]),
      ),
      entry('hidden', [{ ts_ms: 100_000, net: 1 }]),
    ];
    const { container } = render(
      <BrokerTrajectoryTable series={series} cursorMs={30_000_000} venue="KRX" />,
    );

    expect(screen.getAllByTestId('broker-row')).toHaveLength(13);
    expect(container.querySelectorAll('[data-testid="cursor-marker"]')).toHaveLength(0);
  });

  it('cursor-only rerender moves the marker without changing sparkline geometry', () => {
    const series: BrokerSeriesEntry[] = [
      entry('A', [
        { ts_ms: 1_000, net: 10 },
        { ts_ms: 2_000, net: 30 },
        { ts_ms: 5_000, net: 20 },
      ]),
    ];
    const { container, rerender } = render(
      <BrokerTrajectoryTable series={series} cursorMs={2_000} venue="KRX" />,
    );
    const polyline = container.querySelector('polyline:not([stroke-dasharray])');
    const marker = container.querySelector('[data-testid="cursor-marker"]');
    expect(polyline).not.toBeNull();
    expect(marker).not.toBeNull();
    const pointsBefore = polyline!.getAttribute('points');
    const markerBefore = marker!.getAttribute('x1');

    rerender(<BrokerTrajectoryTable series={series} cursorMs={4_000} venue="KRX" />);

    expect(polyline!.getAttribute('points')).toBe(pointsBefore);
    expect(marker!.getAttribute('x1')).not.toBe(markerBefore);
  });

  it('series rerender refreshes sparkline geometry while keeping cursor marker valid', () => {
    const series1: BrokerSeriesEntry[] = [
      entry('A', [
        { ts_ms: 1_000, net: 10 },
        { ts_ms: 2_000, net: 30 },
        { ts_ms: 5_000, net: 20 },
      ]),
    ];
    const series2: BrokerSeriesEntry[] = [
      entry('A', [
        { ts_ms: 1_000, net: 10 },
        { ts_ms: 2_000, net: 80 },
        { ts_ms: 5_000, net: 20 },
      ]),
    ];
    const { container, rerender } = render(
      <BrokerTrajectoryTable series={series1} cursorMs={2_000} venue="KRX" />,
    );
    const polyline = container.querySelector('polyline:not([stroke-dasharray])');
    expect(polyline).not.toBeNull();
    const pointsBefore = polyline!.getAttribute('points');

    rerender(<BrokerTrajectoryTable series={series2} cursorMs={2_000} venue="KRX" />);

    expect(polyline!.getAttribute('points')).not.toBe(pointsBefore);
    expect(container.querySelector('[data-testid="cursor-marker"]')).not.toBeNull();
  });
});

describe('BrokerTrajectoryTable — 0선·커서 도트·규모 바·관측 전 표기', () => {
  const series: BrokerSeriesEntry[] = [
    entry('A', [
      { ts_ms: 1_000, net: 100 },
      { ts_ms: 5_000, net: 120 },
    ]),
    entry('B', [
      { ts_ms: 1_000, net: -50 },
      { ts_ms: 5_000, net: -80 },
    ], 'sell'),
    entry('C', [{ ts_ms: 4_000, net: 30 }]),   // 커서(3_000) 시점엔 아직 등장 전
  ];

  it('renders a zero baseline in every sparkline', () => {
    const { container } = render(
      <BrokerTrajectoryTable series={series} cursorMs={3_000} venue="KRX" />,
    );
    expect(container.querySelectorAll('[data-testid="zero-baseline"]')).toHaveLength(3);
  });

  it('renders a cursor value dot only where the trajectory exists at the cursor', () => {
    const { container } = render(
      <BrokerTrajectoryTable series={series} cursorMs={3_000} venue="KRX" />,
    );
    // A·B는 궤적 범위 안(1s~5s), C는 첫 관측(4s) 이전이라 도트 없음.
    expect(container.querySelectorAll('[data-testid="cursor-value-dot"]')).toHaveLength(2);
  });

  it('renders magnitude strips proportional to |net| across rows', () => {
    const { container } = render(
      <BrokerTrajectoryTable series={series} cursorMs={3_000} venue="KRX" />,
    );
    const bars = container.querySelectorAll<HTMLElement>('[data-testid="broker-net-bar"]');
    expect(bars).toHaveLength(2);   // C는 관측 전이라 바 없음
    expect(bars[0].style.width).toBe('100%');   // A: |100| / max(100)
    expect(bars[1].style.width).toBe('50%');    // B: |-50| / max(100)
    // 숫자 아래 2px 스트립 — 저알파 tint 가 아닌 솔리드 방향색(+감쇠).
    expect(bars[0].style.background).toContain('--price-up');
    expect(bars[1].style.background).toContain('--price-down');
  });

  it('shows an em-dash (not 0) when the cursor precedes the first observation', () => {
    render(<BrokerTrajectoryTable series={series} cursorMs={3_000} venue="KRX" />);
    const preobs = screen.getAllByTestId('broker-net-preobs');
    expect(preobs).toHaveLength(1);
    expect(preobs[0]).toHaveTextContent('—');
  });
});

describe('BrokerTrajectoryTable — 표 크롬(순매도 경계·외국계)', () => {
  it('열 헤더 라벨을 렌더하지 않는다 (2026-07-29 사용자 요청)', () => {
    render(<BrokerTrajectoryTable series={[entry('A', [{ ts_ms: 1_000, net: 5 }])]} cursorMs={null} venue="KRX" />);
    for (const label of ['거래원', '당일 궤적', '순매수(주)', '순매도']) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it('marks the 순매수/순매도 boundary once, at the first negative final_net row', () => {
    const series: BrokerSeriesEntry[] = [
      entry('A', [{ ts_ms: 1_000, net: 100 }]),
      entry('B', [{ ts_ms: 1_000, net: 20 }]),
      entry('C', [{ ts_ms: 1_000, net: -30 }], 'sell'),
      entry('D', [{ ts_ms: 1_000, net: -90 }], 'sell'),
    ];
    render(<BrokerTrajectoryTable series={series} cursorMs={2_000} venue="KRX" />);
    expect(screen.getAllByTestId('broker-sell-divider')).toHaveLength(1);
  });

  it('omits the boundary when every broker is on the buy side', () => {
    const series: BrokerSeriesEntry[] = [
      entry('A', [{ ts_ms: 1_000, net: 100 }]),
      entry('B', [{ ts_ms: 1_000, net: 20 }]),
    ];
    render(<BrokerTrajectoryTable series={series} cursorMs={2_000} venue="KRX" />);
    expect(screen.queryByTestId('broker-sell-divider')).toBeNull();
  });

  it('omits the boundary when the top row is already a seller (all-sell day)', () => {
    // sellStart === 0 — 경계선이 첫 행 위에 떠 헤더와 붙는 것을 막는다.
    const series: BrokerSeriesEntry[] = [
      entry('A', [{ ts_ms: 1_000, net: -10 }], 'sell'),
      entry('B', [{ ts_ms: 1_000, net: -90 }], 'sell'),
    ];
    render(<BrokerTrajectoryTable series={series} cursorMs={2_000} venue="KRX" />);
    expect(screen.queryByTestId('broker-sell-divider')).toBeNull();
  });

  it('badges foreign desks and sums only their cursor-time nets', () => {
    const series: BrokerSeriesEntry[] = [
      entry('키움증권', [{ ts_ms: 1_000, net: 500 }]),
      entry('JP모간', [{ ts_ms: 1_000, net: 200 }]),
      entry('모건스탠리증권', [{ ts_ms: 1_000, net: -50 }], 'sell'),
    ];
    render(<BrokerTrajectoryTable series={series} cursorMs={2_000} venue="KRX" />);
    expect(screen.getAllByTestId('broker-foreign-badge')).toHaveLength(2);
    // 국내(키움 +500)는 제외 — 200 + (-50) = 150.
    expect(screen.getByTestId('broker-foreign-sum')).toHaveTextContent('+150');
  });

  it('shows an em-dash for the foreign total when no foreign desk is observed', () => {
    const series: BrokerSeriesEntry[] = [entry('키움증권', [{ ts_ms: 1_000, net: 500 }])];
    render(<BrokerTrajectoryTable series={series} cursorMs={2_000} venue="KRX" />);
    expect(screen.queryByTestId('broker-foreign-badge')).toBeNull();
    expect(screen.getByTestId('broker-foreign-sum')).toHaveTextContent('—');
  });

  it('excludes pre-observation rows (—) from the foreign total', () => {
    const series: BrokerSeriesEntry[] = [
      entry('JP모간', [{ ts_ms: 1_000, net: 200 }]),
      entry('골드만', [{ ts_ms: 9_000, net: 999 }]),   // 커서(2_000) 시점엔 등장 전
    ];
    render(<BrokerTrajectoryTable series={series} cursorMs={2_000} venue="KRX" />);
    expect(screen.getByTestId('broker-foreign-sum')).toHaveTextContent('+200');
  });

  // 합계행은 footer 다 — 창을 키워 스크롤이 사라져도 바닥에 붙어 있어야 한다.
  // sticky 는 스크롤이 있을 때만 일하므로 mt-auto(+ flex 기둥)가 함께 있어야
  // 한다. 실측(2026-07-30): mt-auto 없이는 창을 키웠을 때 합계행 아래로 250px
  // 빈 공간이 생겼다.
  it('pins the foreign total row to the window floor as a footer', () => {
    const series: BrokerSeriesEntry[] = [entry('JP모간', [{ ts_ms: 1_000, net: 200 }])];
    const { container } = render(<BrokerTrajectoryTable series={series} cursorMs={2_000} venue="KRX" />);

    const totalRow = screen.getByText('외국계 합계').parentElement;
    expect(totalRow).toHaveClass('mt-auto');   // 여유 공간을 위로 밀어낸다(짧을 때)
    expect(totalRow).toHaveClass('sticky');    // 스크롤을 버틴다(넘칠 때)
    expect(totalRow).toHaveClass('shrink-0');

    // mt-auto 는 flex 기둥 안에서만 뜻이 있다.
    const root = container.firstElementChild;
    expect(root).toHaveClass('flex');
    expect(root).toHaveClass('flex-col');
    expect(root).toHaveClass('min-h-full');
  });

  // 2026-07-30 사용자 결정: 합계행은 창 본문(--bg-card)과 같은 배경 — 밴드 금지.
  // sticky 라 배경 클래스 자체는 남아야 한다(투명하면 스크롤 행이 뒤로 비친다).
  it('keeps the foreign total row on the window body background (no tone band)', () => {
    const series: BrokerSeriesEntry[] = [entry('JP모간', [{ ts_ms: 1_000, net: 200 }])];
    render(<BrokerTrajectoryTable series={series} cursorMs={2_000} venue="KRX" />);
    const totalRow = screen.getByText('외국계 합계').parentElement;
    expect(totalRow).toHaveClass('bg-bg-card');
    expect(totalRow).not.toHaveClass('bg-bg-subtle');
    expect(totalRow).toHaveClass('sticky');
  });
});
