import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import DayBoundaryOverlay from './DayBoundaryOverlay';
import { useChartPrefsStore } from '../state/chartPrefs';
import type { DayBoundaryTick } from './dayBoundaryTicks';

function makeChart(paneWidth = 498, timeAxisHeight = 28) {
  const subscribers = new Set<() => void>();
  const timeScale = {
    timeToCoordinate: vi.fn(() => 120),
    // pane 폭 / 시간축 높이 — 오버레이는 이 둘로 스스로를 pane 영역에 가둬
    // 구분선이 우측 가격 라벨과 하단 날짜 라벨 위로 새지 않게 한다.
    width: vi.fn(() => paneWidth),
    height: vi.fn(() => timeAxisHeight),
    subscribeVisibleLogicalRangeChange: vi.fn((cb: () => void) => subscribers.add(cb)),
    unsubscribeVisibleLogicalRangeChange: vi.fn((cb: () => void) => subscribers.delete(cb)),
  };

  return {
    timeScale: () => timeScale,
  };
}

const boundaries: readonly DayBoundaryTick[] = [{ date: '20260616', virtualMs: 1_800_000 }];

describe('DayBoundaryOverlay', () => {
  beforeEach(() => {
    useChartPrefsStore.getState().resetToDefaults();
  });

  afterEach(cleanup);

  it('renders no boundary when disabled', () => {
    useChartPrefsStore.getState().setToggle('dayBoundaryEnabled', false);
    render(<DayBoundaryOverlay chart={makeChart() as never} boundaries={boundaries} />);

    expect(screen.queryByTestId('day-boundary-20260616')).toBeNull();
  });

  it('applies configured color and line width', () => {
    useChartPrefsStore.getState().setDayBoundaryStyle({ color: '#EF4444', lineWidth: 3 });
    render(<DayBoundaryOverlay chart={makeChart() as never} boundaries={boundaries} />);

    const boundary = screen.getByTestId('day-boundary-20260616');
    expect(boundary.style.width).toBe('3px');
    expect(boundary.style.backgroundImage).toContain('rgb(239, 68, 68)');
  });

  // 축 누수 회귀 — 컨테이너를 pane 영역으로 잘라 두지 않으면 x > paneWidth 인
  // 구분선이 우측 가격 라벨 배경 위에, 선의 아래쪽 끝이 하단 시간축의 날짜 라벨
  // 위에 그려진다. 폭·높이·overflow 중 하나만 빠져도 새므로 셋 다 단언한다.
  it('clips itself to the pane box so lines never reach either axis gutter', () => {
    render(<DayBoundaryOverlay chart={makeChart(498, 28) as never} boundaries={boundaries} />);

    const clip = screen.getByTestId('day-boundary-clip');
    expect(clip.style.width).toBe('498px');
    expect(clip.style.bottom).toBe('28px');
    expect(clip.className).toContain('overflow-hidden');
    // 컨테이너가 우측·하단으로 늘어나지 않도록 `inset-0`/`inset-y-0` 가 아니라
    // 좌상단 고정 + 명시 폭·bottom 이어야 한다.
    expect(clip.className).not.toContain('inset-0');
    expect(clip.className).not.toContain('inset-y-0');
  });

  it('attaches the resize observer after enabling from a disabled start', async () => {
    const observe = vi.fn();
    const disconnect = vi.fn();
    const ResizeObserverMock = vi.fn(function ResizeObserverMock() {
      return { observe, disconnect };
    });
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = ResizeObserverMock as never;
    useChartPrefsStore.getState().setToggle('dayBoundaryEnabled', false);

    try {
      render(
        <div data-testid="chart-host">
          <DayBoundaryOverlay chart={makeChart() as never} boundaries={boundaries} />
        </div>,
      );

      expect(observe).not.toHaveBeenCalled();

      act(() => {
        useChartPrefsStore.getState().setToggle('dayBoundaryEnabled', true);
      });

      await waitFor(() => {
        expect(observe).toHaveBeenCalledWith(screen.getByTestId('chart-host'));
      });
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });
});
