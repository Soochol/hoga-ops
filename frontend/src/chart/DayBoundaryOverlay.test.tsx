import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import DayBoundaryOverlay from './DayBoundaryOverlay';
import { useChartPrefsStore } from '../state/chartPrefs';
import type { VirtualAxis } from '../util/virtualAxis';

function makeChart(paneWidth = 498) {
  const subscribers = new Set<() => void>();
  const timeScale = {
    timeToCoordinate: vi.fn(() => 120),
    // pane 폭 — 컨테이너 폭(가격축 거터 포함)보다 좁다. 오버레이는 이 값으로
    // 스스로를 잘라 구분선이 가격 라벨 위로 새지 않게 한다.
    width: vi.fn(() => paneWidth),
    subscribeVisibleLogicalRangeChange: vi.fn((cb: () => void) => subscribers.add(cb)),
    unsubscribeVisibleLogicalRangeChange: vi.fn((cb: () => void) => subscribers.delete(cb)),
  };

  return {
    timeScale: () => timeScale,
  };
}

const axis = {
  segments: [
    { date: '20260615' },
    { date: '20260616' },
  ],
  dayBoundaries: [
    { date: '20260616', virtualStart: 1_800_000 },
  ],
} as unknown as VirtualAxis;

describe('DayBoundaryOverlay', () => {
  beforeEach(() => {
    useChartPrefsStore.getState().resetToDefaults();
  });

  afterEach(cleanup);

  it('renders no boundary when disabled', () => {
    useChartPrefsStore.getState().setToggle('dayBoundaryEnabled', false);
    render(<DayBoundaryOverlay chart={makeChart() as never} axis={axis} />);

    expect(screen.queryByTestId('day-boundary-20260616')).toBeNull();
  });

  it('applies configured color and line width', () => {
    useChartPrefsStore.getState().setDayBoundaryStyle({ color: '#EF4444', lineWidth: 3 });
    render(<DayBoundaryOverlay chart={makeChart() as never} axis={axis} />);

    const boundary = screen.getByTestId('day-boundary-20260616');
    expect(boundary.style.width).toBe('3px');
    expect(boundary.style.backgroundImage).toContain('rgb(239, 68, 68)');
  });

  // 가격축(우측 거터) 누수 회귀 — 컨테이너를 pane 폭으로 잘라 두지 않으면
  // x > paneWidth 인 구분선이 가격 라벨 배경 위에 그려진다. 폭과 overflow 중
  // 하나만 있어도 새므로 둘 다 단언한다.
  it('clips itself to the pane width so lines never reach the price axis gutter', () => {
    render(<DayBoundaryOverlay chart={makeChart(498) as never} axis={axis} />);

    const clip = screen.getByTestId('day-boundary-clip');
    expect(clip.style.width).toBe('498px');
    expect(clip.className).toContain('overflow-hidden');
    // 컨테이너가 우측으로 늘어나지 않도록 `inset-0` 이 아니라 좌측 고정이어야 한다.
    expect(clip.className).not.toContain('inset-0');
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
          <DayBoundaryOverlay chart={makeChart() as never} axis={axis} />
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
