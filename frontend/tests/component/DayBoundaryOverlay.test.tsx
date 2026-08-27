import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ISeriesApi } from 'lightweight-charts';

import DayBoundaryOverlay from '../../src/chart/DayBoundaryOverlay';
import {
  computeBoundaryLines,
  type DayBoundaryPrimitive,
} from '../../src/chart/DayBoundaryPrimitive';
import { resolveDayBoundaryTicks } from '../../src/chart/sessionSpans';
import type { DayBoundaryTick } from '../../src/chart/sessionSpans';
import type { PaneSeriesMap } from '../../src/chart/drawing/chartCoordinates';
import type { PaneId } from '../../src/chart/drawing/types';
import { createVirtualAxis, type VirtualAxis } from '../../src/util/virtualAxis';
import { useChartPrefsStore } from '../../src/state/chartPrefs';
import type { Candle } from '../../src/api/types';

afterEach(cleanup);
beforeEach(() => {
  useChartPrefsStore.getState().resetToDefaults();
});

/**
 * 이 파일이 묻는 것은 **"이 캔들 데이터 + 이 축에서 구분선이 몇 개, 어느 날짜에
 * 서는가"** 다. 옛 DOM 구현에선 그 답을 `[data-day-boundary]` 노드 수로 읽었지만
 * 질문 자체는 DOM 과 무관하다 — 이제 host 가 primitive 에 넘긴 스냅샷을 `draw` 가
 * 쓰는 바로 그 함수(`computeBoundaryLines`)에 태워 같은 답을 읽는다.
 */
function drawnBoundaryDates(
  boundaries: readonly DayBoundaryTick[],
  timeToCoordinate: (virtualSec: number) => number | null,
): string[] {
  const series = {
    attachPrimitive: vi.fn(),
    detachPrimitive: vi.fn(),
  } as unknown as ISeriesApi<'Candlestick'> & { attachPrimitive: ReturnType<typeof vi.fn> };
  const paneSeries = new Map([['candle' as PaneId, series]]) as unknown as PaneSeriesMap;

  render(<DayBoundaryOverlay paneSeries={paneSeries} boundaries={boundaries} />);

  const prim = series.attachPrimitive.mock.calls[0]?.[0] as DayBoundaryPrimitive | undefined;
  const snap = prim?.snapshot();
  if (!snap) return [];
  // pane 폭 498 — 옛 mock 축의 실측값 그대로.
  return computeBoundaryLines(snap.boundaries, timeToCoordinate, snap.lineWidth, 498).map(
    (b) => b.date,
  );
}

/**
 * lwc 의 시간축을 있는 그대로 흉내 낸다 — `timeToCoordinate` 는 **보간이 아니라
 * 조회**라 데이터에 없는 시각에는 `null` 을 준다. 브라우저 실측으로 확인한 동작이고
 * (005380 3분봉: 20260602 개장 정각 → null, 그 날 첫 캔들 09:12 → 372.08px), 이
 * 성질 때문에 구분선이 사라졌다.
 */
function pointsAt(candles: readonly Candle[], axis: VirtualAxis) {
  const known = new Set(
    candles
      .map((c) => axis.classifyAndProject(c.ts_ms))
      .filter((p) => p.contained)
      .map((p) => p.virtual / 1000),
  );
  return (sec: number) => (known.has(sec) ? 200 : null);
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
  it('세그먼트가 하나면 경계가 없다', () => {
    expect(drawnBoundaryDates(ticksFor([RAW_SEGMENTS[0]]), () => 100)).toEqual([]);
  });

  it('N 세그먼트 → N-1 경계', () => {
    // 3 segments → 2 boundaries
    expect(drawnBoundaryDates(ticksFor(RAW_SEGMENTS), () => 200)).toEqual(['20260513', '20260514']);
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

    expect(
      drawnBoundaryDates(resolveDayBoundaryTicks(candles, axis), pointsAt(candles, axis)),
    ).toEqual(['20260513']);
  });

  // 좌표가 없으면(뷰가 아직 그 구간을 모르는 등) 그 줄만 빠진다 — 남은 방어.
  it('좌표를 못 얻은 경계는 그 줄만 건너뛴다', () => {
    expect(drawnBoundaryDates(ticksFor(RAW_SEGMENTS), () => null)).toEqual([]);
  });

  // 날짜 칩은 커밋 b6cd06f 에서 제거됐다 — 날짜·월 라벨은 적응형 x 축이 그린다
  // (`util/kstHorzScaleBehavior`). primitive 는 선만 그으므로 캔버스에 글자를
  // 쓰는 호출이 있으면 그 결정이 뒤집힌 것이다.
  it('선만 긋는다 — 날짜 칩은 x 축이 갖는다', () => {
    const series = {
      attachPrimitive: vi.fn(),
      detachPrimitive: vi.fn(),
    } as unknown as ISeriesApi<'Candlestick'> & { attachPrimitive: ReturnType<typeof vi.fn> };
    const paneSeries = new Map([['candle' as PaneId, series]]) as unknown as PaneSeriesMap;
    render(<DayBoundaryOverlay paneSeries={paneSeries} boundaries={ticksFor(RAW_SEGMENTS)} />);
    const prim = series.attachPrimitive.mock.calls[0][0] as DayBoundaryPrimitive;
    prim.attached({
      chart: { timeScale: () => ({ timeToCoordinate: () => 200 }) },
      series,
      requestUpdate: vi.fn(),
    } as never);

    const ctx = {
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      setLineDash: vi.fn(),
      fillText: vi.fn(),
      strokeText: vi.fn(),
      strokeStyle: '',
      lineWidth: 0,
    };
    prim.paneViews()[0].renderer()?.draw({
      useMediaCoordinateSpace: <T,>(f: (scope: never) => T): T =>
        f({ context: ctx, mediaSize: { width: 498, height: 200 } } as never),
    } as never);

    expect(ctx.stroke).toHaveBeenCalled();
    expect(ctx.fillText).not.toHaveBeenCalled();
    expect(ctx.strokeText).not.toHaveBeenCalled();
  });
});
