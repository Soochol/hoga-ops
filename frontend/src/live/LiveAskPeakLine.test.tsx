import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import LiveAskPeakLine from './LiveAskPeakLine';
import { useLivePageStore } from '../state/livePage';

// fake price line + series + paneSeries (LiveCurrentPriceLine.test.tsx에서 복제)
function fakeSeries() {
  const line = { applyOptions: vi.fn() };
  const series = { createPriceLine: vi.fn(() => line), removePriceLine: vi.fn() };
  const paneSeries = new Map([['candle', series]]);
  return { line, series, paneSeries };
}

beforeEach(() => {
  cleanup();
  useLivePageStore.setState({ askPeakEnabled: true, askPeakColor: '#1D4ED8', askPeakLineWidth: 2 } as any);
});

describe('LiveAskPeakLine', () => {
  it('peak 있으면 price line 생성(가격·색·두께)', () => {
    const { series, paneSeries } = fakeSeries();
    render(<LiveAskPeakLine paneSeries={paneSeries as never} peak={{ price: 25100, qty: 123456, t_ms: 1 }} />);
    expect(series.createPriceLine).toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = (series.createPriceLine.mock.calls as any[][])[0]![0] as Record<string, unknown>;
    expect(opts.price).toBe(25100);
    expect(opts.color).toBe('#1D4ED8');
    expect(opts.lineWidth).toBe(2);
    expect(opts.title).toContain('12.3만'); // formatQtyKo
  });

  it('토글 off면 lineVisible=false', () => {
    useLivePageStore.setState({ askPeakEnabled: false } as any);
    const { series, paneSeries } = fakeSeries();
    render(<LiveAskPeakLine paneSeries={paneSeries as never} peak={{ price: 25100, qty: 100, t_ms: 1 }} />);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = (series.createPriceLine.mock.calls as any[][])[0]![0] as Record<string, unknown>;
    expect(opts.lineVisible).toBe(false);
  });

  it('peak null이면 lineVisible=false', () => {
    const { series, paneSeries } = fakeSeries();
    render(<LiveAskPeakLine paneSeries={paneSeries as never} peak={null} />);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = (series.createPriceLine.mock.calls as any[][])[0]![0] as Record<string, unknown>;
    expect(opts.lineVisible).toBe(false);
  });
});
