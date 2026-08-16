import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { ISeriesApi } from 'lightweight-charts';
import StudySavedRangeBandHost from './StudySavedRangeBandHost';
import { StudySavedRangeBandPrimitive } from '../chart/StudySavedRangeBandPrimitive';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { PaneId } from '../chart/drawing/types';
import type { VirtualAxis } from '../util/virtualAxis';
import type { StudySavedRangeMarks } from './studyDailyContext';

const axis = { toVirtual: (ms: number) => ms } as unknown as VirtualAxis;
const marks: StudySavedRangeMarks = { fromMs: 1_780_000_000_000, toMs: 1_781_000_000_000, barCount: 12 };

function makeSeries() {
  return {
    attachPrimitive: vi.fn(),
    detachPrimitive: vi.fn(),
  } as unknown as ISeriesApi<'Line'> & {
    attachPrimitive: ReturnType<typeof vi.fn>;
    detachPrimitive: ReturnType<typeof vi.fn>;
  };
}

function makePaneSeries(...paneIds: string[]) {
  const entries = paneIds.map((id) => [id as PaneId, makeSeries()] as const);
  return {
    map: new Map(entries) as unknown as PaneSeriesMap,
    series: entries.map(([, s]) => s),
  };
}

describe('StudySavedRangeBandHost', () => {
  afterEach(cleanup);

  // 밴드는 캔들 pane 바닥에서 끊기면 안 된다 — 옛 DOM 오버레이는 차트 전체 높이를
  // 덮어 거래량·보조지표 pane 까지 이어졌고, primitive 는 자기가 달린 pane 캔버스에만
  // 그리므로 pane 마다 하나씩 붙여야 그 모양이 유지된다(#1238 계열 시각 회귀 가드).
  it('모든 pane 에 primitive 를 하나씩 붙인다 — 캔들 pane 에만 붙이면 밴드가 끊긴다', () => {
    const { map, series } = makePaneSeries('candle', 'volume', 'ratio');

    render(<StudySavedRangeBandHost axis={axis} paneSeries={map} marks={marks} />);

    for (const s of series) {
      expect(s.attachPrimitive).toHaveBeenCalledTimes(1);
      expect(s.attachPrimitive.mock.calls[0][0]).toBeInstanceOf(StudySavedRangeBandPrimitive);
    }
  });

  it('언마운트 시 붙인 primitive 를 전부 뗀다', () => {
    const { map, series } = makePaneSeries('candle', 'volume');

    const { unmount } = render(<StudySavedRangeBandHost axis={axis} paneSeries={map} marks={marks} />);
    unmount();

    for (const s of series) {
      expect(s.detachPrimitive).toHaveBeenCalledTimes(1);
      expect(s.detachPrimitive.mock.calls[0][0]).toBe(s.attachPrimitive.mock.calls[0][0]);
    }
  });

  // 생산부(`StudyPage`)가 매 렌더 `studySavedRangeMarks()` 를 새로 호출해 marks 식별자가
  // churn 한다. 값이 같은데도 재부착하면 팬 중 밴드가 한 프레임 사라진다.
  it('값이 같은 새 marks 객체엔 재부착하지 않는다', () => {
    const { map, series } = makePaneSeries('candle');

    const { rerender } = render(<StudySavedRangeBandHost axis={axis} paneSeries={map} marks={marks} />);
    rerender(<StudySavedRangeBandHost axis={axis} paneSeries={map} marks={{ ...marks }} />);

    expect(series[0].attachPrimitive).toHaveBeenCalledTimes(1);
    expect(series[0].detachPrimitive).not.toHaveBeenCalled();
  });

  it('DOM 을 그리지 않는다 — 그리기는 캔버스 패스가 한다', () => {
    const { map } = makePaneSeries('candle');

    const { container } = render(<StudySavedRangeBandHost axis={axis} paneSeries={map} marks={marks} />);

    expect(container.innerHTML).toBe('');
  });
});
