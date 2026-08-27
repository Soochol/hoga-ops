import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ISeriesApi } from 'lightweight-charts';
import DayBoundaryOverlay from './DayBoundaryOverlay';
import { DayBoundaryPrimitive } from './DayBoundaryPrimitive';
import type { DayBoundaryTick } from './sessionSpans';
import type { PaneSeriesMap } from './drawing/chartCoordinates';
import type { PaneId } from './drawing/types';
import { useChartPrefsStore } from '../state/chartPrefs';

const boundaries: readonly DayBoundaryTick[] = [{ date: '20260616', virtualMs: 1_800_000 }];

function makeSeries() {
  return {
    attachPrimitive: vi.fn(),
    detachPrimitive: vi.fn(),
  } as unknown as ISeriesApi<'Candlestick'> & {
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

/** 해당 series 에 붙은 primitive — host 가 draw 시점에 넘길 스냅샷을 여기서 읽는다. */
function attachedPrimitive(series: ReturnType<typeof makeSeries>): DayBoundaryPrimitive {
  return series.attachPrimitive.mock.calls[0][0] as DayBoundaryPrimitive;
}

describe('DayBoundaryOverlay', () => {
  beforeEach(() => {
    useChartPrefsStore.getState().resetToDefaults();
  });

  afterEach(cleanup);

  // 구분선은 캔들 pane 바닥에서 끊기면 안 된다 — 옛 DOM 오버레이는 차트 전체 높이를
  // 덮어 거래량·보조지표 pane 까지 이어졌고, primitive 는 자기가 달린 pane 캔버스에만
  // 그리므로 pane 마다 하나씩 붙여야 그 모양이 유지된다.
  it('모든 pane 에 primitive 를 하나씩 붙인다 — 캔들 pane 에만 붙이면 선이 끊긴다', () => {
    const { map, series } = makePaneSeries('candle', 'volume', 'ratio');

    render(<DayBoundaryOverlay paneSeries={map} boundaries={boundaries} />);

    for (const s of series) {
      expect(s.attachPrimitive).toHaveBeenCalledTimes(1);
      expect(s.attachPrimitive.mock.calls[0][0]).toBeInstanceOf(DayBoundaryPrimitive);
    }
  });

  it('언마운트 시 붙인 primitive 를 전부 뗀다', () => {
    const { map, series } = makePaneSeries('candle', 'volume');

    const { unmount } = render(<DayBoundaryOverlay paneSeries={map} boundaries={boundaries} />);
    unmount();

    for (const s of series) {
      expect(s.detachPrimitive).toHaveBeenCalledTimes(1);
      expect(s.detachPrimitive.mock.calls[0][0]).toBe(s.attachPrimitive.mock.calls[0][0]);
    }
  });

  it('꺼져 있으면 아무 pane 에도 붙이지 않는다', () => {
    useChartPrefsStore.getState().setToggle('dayBoundaryEnabled', false);
    const { map, series } = makePaneSeries('candle', 'volume');

    render(<DayBoundaryOverlay paneSeries={map} boundaries={boundaries} />);

    for (const s of series) expect(s.attachPrimitive).not.toHaveBeenCalled();
  });

  it('꺼진 채 마운트했다가 켜면 그때 붙는다', () => {
    useChartPrefsStore.getState().setToggle('dayBoundaryEnabled', false);
    const { map, series } = makePaneSeries('candle');

    render(<DayBoundaryOverlay paneSeries={map} boundaries={boundaries} />);
    expect(series[0].attachPrimitive).not.toHaveBeenCalled();

    act(() => {
      useChartPrefsStore.getState().setToggle('dayBoundaryEnabled', true);
    });

    expect(series[0].attachPrimitive).toHaveBeenCalledTimes(1);
    // 붙자마자 스냅샷이 서 있어야 첫 프레임이 빈 그림이 되지 않는다.
    expect(attachedPrimitive(series[0]).snapshot()).toMatchObject({ boundaries });
  });

  it('켜져 있다가 끄면 뗀다', () => {
    const { map, series } = makePaneSeries('candle');

    render(<DayBoundaryOverlay paneSeries={map} boundaries={boundaries} />);

    act(() => {
      useChartPrefsStore.getState().setToggle('dayBoundaryEnabled', false);
    });

    expect(series[0].detachPrimitive).toHaveBeenCalledTimes(1);
  });

  // 스타일 변경은 팬/줌과 달리 lwc 가 스스로 다시 그릴 이유가 없다 — 호스트가
  // 스냅샷을 갈고 **repaint 를 요청해야** 화면에 반영된다. 요청을 빠뜨리면 색을
  // 바꿔도 다음 팬 전까지 옛 색이 남는다.
  it('설정한 색·두께를 스냅샷으로 넘기고 repaint 를 요청한다', () => {
    const requestUpdate = vi.spyOn(DayBoundaryPrimitive.prototype, 'requestUpdate');
    const { map, series } = makePaneSeries('candle');

    render(<DayBoundaryOverlay paneSeries={map} boundaries={boundaries} />);
    const attachCalls = requestUpdate.mock.calls.length;

    act(() => {
      useChartPrefsStore.getState().setDayBoundaryStyle({ color: '#EF4444', lineWidth: 3 });
    });

    expect(attachedPrimitive(series[0]).snapshot()).toEqual({
      boundaries,
      color: '#EF4444',
      lineWidth: 3,
    });
    expect(requestUpdate.mock.calls.length).toBeGreaterThan(attachCalls);
    requestUpdate.mockRestore();
  });

  // 이 컴포넌트가 DOM 을 그리면 그리기 경로가 둘로 갈리고, 그 경로가 곧 한 프레임
  // 팬 지연이었다. 그리기는 전적으로 캔버스 패스가 한다.
  it('DOM 을 그리지 않는다 — 그리기는 캔버스 패스가 한다', () => {
    const { map } = makePaneSeries('candle');

    const { container } = render(<DayBoundaryOverlay paneSeries={map} boundaries={boundaries} />);

    expect(container.innerHTML).toBe('');
  });

  // 값이 같은데 재부착하면 팬 중 구분선이 한 프레임 사라진다.
  it('같은 paneSeries·boundaries 로 재렌더해도 재부착하지 않는다', () => {
    const { map, series } = makePaneSeries('candle');

    const { rerender } = render(<DayBoundaryOverlay paneSeries={map} boundaries={boundaries} />);
    rerender(<DayBoundaryOverlay paneSeries={map} boundaries={boundaries} />);

    expect(series[0].attachPrimitive).toHaveBeenCalledTimes(1);
    expect(series[0].detachPrimitive).not.toHaveBeenCalled();
  });
});
