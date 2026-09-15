import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { IChartApi, ISeriesApi, SeriesType, UTCTimestamp } from 'lightweight-charts';
import type { RangeBundle } from '../api/types';
import type { PaneId } from '../chart/drawing/types';
import { createVirtualAxis } from '../util/virtualAxis';
import { useLinkedInvestorPaneScale } from './useLinkedInvestorPaneScale';

const DAY = 86_400_000;
const START = Date.UTC(2026, 8, 14);

describe('useLinkedInvestorPaneScale', () => {
  it('sets both scales to the same visible range and restores autoscale on cleanup', async () => {
    const axis = createVirtualAxis([{
      date: '20260914', sessionOpenMs: START, sessionCloseMs: START + DAY,
    }]);
    const bundle = {
      investorPoints: [
        { t_ms: START, foreign_net: 500, institution_net: -300 },
      ],
    } as RangeBundle;
    const makeScale = () => ({ setAutoScale: vi.fn(), setVisibleRange: vi.fn() });
    const foreignScale = makeScale();
    const institutionScale = makeScale();
    const makeSeries = (scale: ReturnType<typeof makeScale>) => ({
      priceScale: () => scale,
    }) as unknown as ISeriesApi<SeriesType>;
    const paneSeries = new Map<PaneId, ISeriesApi<SeriesType>>([
      ['investor-foreign', makeSeries(foreignScale)],
      ['investor-institution', makeSeries(institutionScale)],
    ]);
    let rangeHandler: (() => void) | null = null;
    const timeScale = {
      getVisibleRange: () => ({
        from: (axis.toVirtual(START) / 1000) as UTCTimestamp,
        to: (axis.toVirtual(START + DAY) / 1000) as UTCTimestamp,
      }),
      subscribeVisibleTimeRangeChange: vi.fn((handler: () => void) => { rangeHandler = handler; }),
      unsubscribeVisibleTimeRangeChange: vi.fn(),
    };
    const chart = { timeScale: () => timeScale } as unknown as IChartApi;

    const { unmount } = renderHook(() => useLinkedInvestorPaneScale({
      chart, bundle, axis, paneSeries, enabled: true,
    }));
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });

    expect(foreignScale.setVisibleRange).toHaveBeenCalledWith({ from: -348, to: 548 });
    expect(institutionScale.setVisibleRange).toHaveBeenCalledWith({ from: -348, to: 548 });

    await act(async () => {
      rangeHandler?.();
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(foreignScale.setVisibleRange).toHaveBeenCalledTimes(2);

    unmount();
    expect(foreignScale.setAutoScale).toHaveBeenLastCalledWith(true);
    expect(institutionScale.setAutoScale).toHaveBeenLastCalledWith(true);
    expect(timeScale.unsubscribeVisibleTimeRangeChange).toHaveBeenCalled();
  });
});
