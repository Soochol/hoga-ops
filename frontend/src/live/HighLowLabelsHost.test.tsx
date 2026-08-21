// frontend/src/live/HighLowLabelsHost.test.tsx
//
// 이 호스트가 하는 일은 **배선 하나**다: 설정 → primitive 가 draw 에서 읽을 스냅샷.
// 렌더 자체는 `HighLowLabelsPrimitive.test.ts` 가 픽셀로 잰다. 두 층을 갈라 두는
// 이유는, 렌더만 테스트하면 "그릴 줄은 아는데 설정이 도달하지 않는" 상태가 통과하기
// 때문이다 — 사용자에겐 토글이 죽은 것과 구별되지 않는다.

import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { ISeriesApi, SeriesType } from 'lightweight-charts';
import HighLowLabelsHost from './HighLowLabelsHost';
import type { HighLowLabelsPrimitive } from '../chart/HighLowLabelsPrimitive';
import type { PaneId } from '../chart/drawing/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { RangeBundle } from '../api/types';
import { createVirtualAxis } from '../util/virtualAxis';
import { useChartPrefsStore } from '../state/chartPrefs';

const OPEN = Date.UTC(2026, 5, 12, 0, 0, 0);
const axis = createVirtualAxis(
  [{ date: '20260612', sessionOpenMs: OPEN, sessionCloseMs: OPEN + 6.5 * 3_600_000 }],
  OPEN,
);
const bundle = {
  candles: [{ ts_ms: OPEN + 60_000, open: 100, close: 100, high: 110, low: 90, vol_a: 0, vol_b: 0 }],
} as unknown as RangeBundle;

function renderHost() {
  const attachPrimitive = vi.fn();
  const series = {
    attachPrimitive,
    detachPrimitive: vi.fn(),
    getPane: () => ({ getHeight: () => 300 }),
  } as unknown as ISeriesApi<SeriesType>;
  const paneSeries: PaneSeriesMap = new Map([['candle' as PaneId, series]]);
  // chartElement 가 Element 가 아니면 레전드 실측은 조용히 건너뛴다(teardown 경로와 동일).
  const chart = { chartElement: () => null } as never;

  render(
    <HighLowLabelsHost
      chart={chart}
      bundle={bundle}
      axis={axis}
      paneSeries={paneSeries}
      timeframe="1m"
    />,
  );
  const prim = attachPrimitive.mock.calls[0]?.[0] as HighLowLabelsPrimitive | undefined;
  return { attachPrimitive, prim };
}

/** 스냅샷의 켜짐 플래그만 뽑아 본다 — 색·두께는 별도 케이스에서 잰다. */
function onFlags(prim: HighLowLabelsPrimitive | undefined) {
  const snap = prim?.snapshot();
  return {
    level: { high: snap?.levelLines.high.on, low: snap?.levelLines.low.on },
    prior: { high: snap?.priorDayLines.high.on, low: snap?.priorDayLines.low.on },
  };
}

describe('HighLowLabelsHost — 수평선 배선', () => {
  afterEach(cleanup);

  it('고가만 켜면 snapshot.levelLines 가 { high: true, low: false }', () => {
    useChartPrefsStore.setState({
      highLowLabelsEnabled: true,
      highLowHighLineEnabled: true,
      highLowLowLineEnabled: false,
    });

    const { prim } = renderHost();

    expect(onFlags(prim).level).toEqual({ high: true, low: false });
  });

  it('저가만 켜면 { high: false, low: true } — 두 토글이 서로 새지 않는다', () => {
    useChartPrefsStore.setState({
      highLowLabelsEnabled: true,
      highLowHighLineEnabled: false,
      highLowLowLineEnabled: true,
    });

    const { prim } = renderHost();

    expect(onFlags(prim).level).toEqual({ high: false, low: true });
  });

  it('둘 다 꺼도 라벨 스냅샷은 살아 있다 — 가격선만 빠진다', () => {
    useChartPrefsStore.setState({
      highLowLabelsEnabled: true,
      highLowHighLineEnabled: false,
      highLowLowLineEnabled: false,
    });

    const { prim } = renderHost();

    expect(onFlags(prim).level).toEqual({ high: false, low: false });
    expect(prim?.snapshot()?.candles).toHaveLength(1);
  });

  it('이전일 고저선도 각각 독립으로 흘러간다 — 극값 가격선과 서로 새지 않는다', () => {
    useChartPrefsStore.setState({
      highLowLabelsEnabled: true,
      highLowHighLineEnabled: false,
      highLowLowLineEnabled: false,
      highLowPriorHighLineEnabled: true,
      highLowPriorLowLineEnabled: false,
    });

    const { prim } = renderHost();

    expect(onFlags(prim)).toEqual({
      level: { high: false, low: false },
      prior: { high: true, low: false },
    });
  });

  it('색·두께가 스냅샷으로 흘러간다 — 고르지 않은 색은 빈 문자열 그대로 간다', () => {
    // '' 를 여기서 방향색으로 풀지 **않는** 것이 계약이다. 해석은 draw 가 테마를 보고
    // 하므로, 호스트가 미리 구우면 테마를 바꿔도 선 색이 안 따라온다.
    useChartPrefsStore.setState({
      highLowLabelsEnabled: true,
      highLowHighLineEnabled: true,
      highLowHighLineColor: '#00FF00',
      highLowHighLineWidth: 3,
      highLowLowLineEnabled: true,
      highLowLowLineColor: '',
      highLowLowLineWidth: 2,
    });

    const snap = renderHost().prim?.snapshot();

    expect(snap?.levelLines.high).toEqual({ on: true, color: '#00FF00', width: 3 });
    expect(snap?.levelLines.low).toEqual({ on: true, color: '', width: 2 });
  });

  it('부모(고저 극값 라벨)를 끄면 하위 토글이 켜져 있어도 primitive 자체가 붙지 않는다', () => {
    // 부모 게이팅의 유일한 구현 지점 — 하위 pref 값은 보존되지만 아무것도 그려지지 않는다.
    useChartPrefsStore.setState({
      highLowLabelsEnabled: false,
      highLowHighLineEnabled: true,
      highLowLowLineEnabled: true,
      highLowPriorHighLineEnabled: true,
      highLowPriorLowLineEnabled: true,
    });

    const { attachPrimitive, prim } = renderHost();

    expect(attachPrimitive).not.toHaveBeenCalled();
    expect(prim).toBeUndefined();
  });
});
