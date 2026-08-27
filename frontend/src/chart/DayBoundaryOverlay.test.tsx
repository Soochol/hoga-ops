import { cleanup, render } from '@testing-library/react';
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

  it('붙자마자 스냅샷이 서 있다 — 첫 프레임이 빈 그림이 되지 않는다', () => {
    const { map, series } = makePaneSeries('candle');

    render(<DayBoundaryOverlay paneSeries={map} boundaries={boundaries} />);

    expect(attachedPrimitive(series[0]).snapshot()).toBe(boundaries);
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

  // 켜고 끄는 prefs 는 2026-08-27 에 사라졌다 — 분봉이면 **항상** 그린다(D/W/M 은
  // 마운트 게이트가 애초에 이 컴포넌트를 세우지 않는다). 저장소에 옛 키가 남아
  // 있어도 여기 동작을 바꾸지 못한다는 것이 그 제거의 계약이다.
  it('prefs 와 무관하게 항상 붙는다 — 끄는 토글이 없다', () => {
    // 옛 토글 키를 저장소에 억지로 밀어 넣어도(hydrate 잔재를 흉내) 결과가 같아야 한다.
    useChartPrefsStore.setState({ dayBoundaryEnabled: false } as never);
    try {
      const { map, series } = makePaneSeries('candle', 'volume');

      render(<DayBoundaryOverlay paneSeries={map} boundaries={boundaries} />);

      for (const s of series) expect(s.attachPrimitive).toHaveBeenCalledTimes(1);
    } finally {
      // `resetToDefaults()` 는 **merge** 라(`set({...DEFAULT_PREFS})`) 사라진 키를
      // 되돌리지 못한다 — 여기서 치우지 않으면 이 오염이 뒤 테스트로 샌다(실측:
      // red-check 에서 뒤 두 건이 같이 깨졌다).
      useChartPrefsStore.setState((prev) => {
        const next = { ...prev } as Record<string, unknown>;
        delete next.dayBoundaryEnabled;
        return next as never;
      }, true);
    }
  });

  // 경계 목록이 바뀌는 것은 팬/줌과 달리 lwc 가 스스로 알 수 없다 — 호스트가
  // 스냅샷을 갈고 **repaint 를 요청해야** 화면에 반영된다. 요청을 빠뜨리면 새 날의
  // 구분선이 다음 팬 전까지 안 나타난다.
  it('새 경계 목록을 스냅샷으로 넘기고 repaint 를 요청한다', () => {
    const requestUpdate = vi.spyOn(DayBoundaryPrimitive.prototype, 'requestUpdate');
    const { map, series } = makePaneSeries('candle');

    const { rerender } = render(<DayBoundaryOverlay paneSeries={map} boundaries={boundaries} />);
    const attachCalls = requestUpdate.mock.calls.length;

    const next: readonly DayBoundaryTick[] = [
      ...boundaries,
      { date: '20260617', virtualMs: 3_600_000 },
    ];
    rerender(<DayBoundaryOverlay paneSeries={map} boundaries={next} />);

    expect(attachedPrimitive(series[0]).snapshot()).toBe(next);
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
