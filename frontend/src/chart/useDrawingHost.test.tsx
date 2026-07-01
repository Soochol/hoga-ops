import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import { createRef } from 'react';
import { useDrawingHost } from './useDrawingHost';
import type { PaneId } from './drawing/types';

const axis = { segments: [] } as never;
const containerRef = createRef<HTMLDivElement>();

function Harness({
  chart,
  onReady,
}: {
  chart: IChartApi | null;
  onReady: (api: ReturnType<typeof useDrawingHost>) => void;
}) {
  const host = useDrawingHost(chart, axis, '005930', containerRef);
  onReady(host);
  return <div data-testid="pane-series-size">{host.paneSeries.size}</div>;
}

describe('useDrawingHost', () => {
  afterEach(cleanup);

  it('does not expose previous chart pane series after a chart identity switch', () => {
    const chartA = {} as IChartApi;
    const chartB = {} as IChartApi;
    const seriesA = {} as ISeriesApi<'Line'>;
    let host: ReturnType<typeof useDrawingHost> | null = null;

    const { rerender } = render(
      <Harness chart={chartA} onReady={(api) => { host = api; }} />,
    );
    act(() => {
      host!.registerPaneSeries('volume' as PaneId, seriesA);
    });
    expect(screen.getByTestId('pane-series-size').textContent).toBe('1');

    rerender(<Harness chart={chartB} onReady={(api) => { host = api; }} />);

    expect(screen.getByTestId('pane-series-size').textContent).toBe('0');
    expect(host!.paneSeries.get('volume' as PaneId)).toBeUndefined();
  });

  it('ignores stale unregister callbacks from the previous chart', () => {
    const chartA = {} as IChartApi;
    const chartB = {} as IChartApi;
    const seriesA = {} as ISeriesApi<'Line'>;
    const seriesB = {} as ISeriesApi<'Line'>;
    let host: ReturnType<typeof useDrawingHost> | null = null;

    const { rerender } = render(
      <Harness chart={chartA} onReady={(api) => { host = api; }} />,
    );
    const unregisterFromChartA = host!.unregisterPaneSeries;
    act(() => {
      host!.registerPaneSeries('volume' as PaneId, seriesA);
    });

    rerender(<Harness chart={chartB} onReady={(api) => { host = api; }} />);
    act(() => {
      host!.registerPaneSeries('volume' as PaneId, seriesB);
    });
    act(() => {
      unregisterFromChartA('volume' as PaneId);
    });

    expect(screen.getByTestId('pane-series-size').textContent).toBe('1');
    expect(host!.paneSeries.get('volume' as PaneId)).toBe(seriesB);
  });
});
