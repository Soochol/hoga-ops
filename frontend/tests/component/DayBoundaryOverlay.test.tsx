import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { IChartApi } from 'lightweight-charts';

import DayBoundaryOverlay from '../../src/chart/DayBoundaryOverlay';
import { resolveDayBoundaryTicks } from '../../src/chart/sessionSpans';
import { createVirtualAxis, type VirtualAxis } from '../../src/util/virtualAxis';
import type { Candle } from '../../src/api/types';

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
    } as unknown as typeof ResizeObserver;
  }
});

afterEach(cleanup);

function makeMockChart(timeToCoordReturns: (sec: number) => number | null): IChartApi {
  const handlers: Array<(r: unknown) => void> = [];
  return {
    timeScale: () => ({
      timeToCoordinate: (sec: number) => timeToCoordReturns(sec),
      // 오버레이가 스스로를 pane 영역으로 자르기 위해 읽는다(가격축·시간축 누수 방지).
      width: () => 498,
      height: () => 28,
      subscribeVisibleLogicalRangeChange: (h: (r: unknown) => void) => handlers.push(h),
      unsubscribeVisibleLogicalRangeChange: vi.fn(),
    }),
    chartElement: () => document.createElement('div'),
  } as unknown as IChartApi;
}

/**
 * lwc 의 시간축을 있는 그대로 흉내 낸다 — `timeToCoordinate` 는 **보간이 아니라
 * 조회**라 데이터에 없는 시각에는 `null` 을 준다. 브라우저 실측으로 확인한 동작이고
 * (005380 3분봉: 20260602 개장 정각 → null, 그 날 첫 캔들 09:12 → 372.08px), 이
 * 성질 때문에 구분선이 사라졌다.
 */
function makeChartWithPointsAt(candles: readonly Candle[], axis: VirtualAxis): IChartApi {
  const known = new Set(
    candles
      .map((c) => axis.classifyAndProject(c.ts_ms))
      .filter((p) => p.contained)
      .map((p) => p.virtual / 1000),
  );
  return makeMockChart((sec) => (known.has(sec) ? 200 : null));
}

function candlesEvery3m(openMs: number, skipMinutes = 0, count = 4): Candle[] {
  const start = openMs + skipMinutes * 60_000;
  return Array.from({ length: count }, (_, i) => ({
    ts_ms: start + i * 180_000,
    open: 1,
    close: 1,
    high: 1,
    low: 1,
    vol_a: 0,
    vol_b: 0,
  }));
}

const RAW_SEGMENTS = [
  { date: '20260512', sessionOpenMs: 1_000_000, sessionCloseMs: 2_000_000 },
  { date: '20260513', sessionOpenMs: 3_000_000, sessionCloseMs: 4_000_000 },
  { date: '20260514', sessionOpenMs: 5_000_000, sessionCloseMs: 6_000_000 },
];

/** 모든 세션이 개장 정각부터 데이터를 갖는 정상 케이스. */
function ticksFor(raw: typeof RAW_SEGMENTS) {
  const axis = createVirtualAxis(raw);
  const candles = raw.flatMap((s) =>
    Array.from({ length: 3 }, (_, i) => ({
      ts_ms: s.sessionOpenMs + i * 100_000,
      open: 1,
      close: 1,
      high: 1,
      low: 1,
      vol_a: 0,
      vol_b: 0,
    })),
  );
  return resolveDayBoundaryTicks(candles, axis);
}

describe('DayBoundaryOverlay', () => {
  it('renders nothing for N=1 segments (no boundaries)', () => {
    const { container } = render(
      <DayBoundaryOverlay chart={makeMockChart(() => 100)} boundaries={ticksFor([RAW_SEGMENTS[0]])} />,
    );
    expect(container.querySelectorAll('[data-day-boundary]').length).toBe(0);
  });

  it('renders N-1 boundary divs for N segments', () => {
    render(<DayBoundaryOverlay chart={makeMockChart(() => 200)} boundaries={ticksFor(RAW_SEGMENTS)} />);
    // 3 segments → 2 boundaries
    expect(document.querySelectorAll('[data-day-boundary]').length).toBe(2);
  });

  it('renders the divider only — no date chip (the adaptive x-axis owns dates)', () => {
    const { container } = render(
      <DayBoundaryOverlay
        chart={makeMockChart(() => 150)}
        boundaries={ticksFor(RAW_SEGMENTS.slice(0, 2))}
      />,
    );
    // The MM/DD chip was removed (commit b6cd06f) — date/month labels are now
    // rendered by the x-axis (util/kstHorzScaleBehavior). The boundary div is a
    // bare divider with no text content.
    expect(screen.queryByText('5/13')).not.toBeInTheDocument();
    const boundary = container.querySelector('[data-day-boundary]');
    expect(boundary).not.toBeNull();
    expect(boundary?.textContent).toBe('');
  });

  // 실측 결손의 회귀 가드 — 첫 캔들이 개장 정각이 아닌 날(005380 의 20260318 은
  // +6분, 20260602 는 +12분)에 구분선이 통째로 사라졌다. 경계를 개장 정각으로
  // 되돌리면 이 mock 축에 그 시각이 없어 좌표가 null 이 되고 개수가 0 이 된다.
  it('첫 캔들이 개장 정각이 아닌 날에도 구분선이 산다', () => {
    const raw = RAW_SEGMENTS.slice(0, 2);
    const axis = createVirtualAxis(raw);
    const candles = [
      ...candlesEvery3m(raw[0].sessionOpenMs),
      // 둘째 날은 개장 +12분부터 — 개장 정각에는 포인트가 없다.
      ...candlesEvery3m(raw[1].sessionOpenMs, 12),
    ];

    render(
      <DayBoundaryOverlay
        chart={makeChartWithPointsAt(candles, axis)}
        boundaries={resolveDayBoundaryTicks(candles, axis)}
      />,
    );

    expect(document.querySelectorAll('[data-day-boundary]').length).toBe(1);
    expect(document.querySelector('[data-day-boundary="20260513"]')).not.toBeNull();
  });

  // 좌표가 없으면(뷰가 아직 그 구간을 모르는 등) 그 줄만 빠진다 — 남은 방어.
  it('좌표를 못 얻은 경계는 그 줄만 건너뛴다', () => {
    render(<DayBoundaryOverlay chart={makeMockChart(() => null)} boundaries={ticksFor(RAW_SEGMENTS)} />);
    expect(document.querySelectorAll('[data-day-boundary]').length).toBe(0);
    // 컨테이너는 남는다 — 경계가 0개인 것과 축이 없는 것은 다른 상태다.
    expect(document.querySelector('[data-testid="day-boundary-clip"]')).not.toBeNull();
  });
});
