import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

// useQuoteByCode 를 모킹해 react-query/네트워크 없이 quote 를 직접 주입.
vi.mock('../api/liveQuotes', () => ({ useQuoteByCode: vi.fn(() => new Map()) }));
import { useQuoteByCode } from '../api/liveQuotes';
import LiveCurrentPriceLine from './LiveCurrentPriceLine';
import { resolveTokens } from '../util/tokens';
import type { RangeBundle } from '../api/types';
import type { LiveQuote } from '../api/liveQuotes';

const mockUseQuoteByCode = vi.mocked(useQuoteByCode);

// 컴포넌트와 동일한 토큰 해석 — CSS 로드 여부와 무관하게 색 출처를 검증.
const T = resolveTokens({
  up: ['--price-up', '#F04452'],
  down: ['--price-down', '#3485FA'],
  neutral: ['--fg-dim', '#9A9AA8'],
});

function makeSeriesMock() {
  const priceLine = { applyOptions: vi.fn() };
  return { priceLine, createPriceLine: vi.fn(() => priceLine), removePriceLine: vi.fn() };
}

function bundleWith(closes: number[]): RangeBundle {
  return {
    candles: closes.map((c, i) => ({
      ts_ms: i * 1000, open: c, close: c, high: c, low: c, vol_a: 0, vol_b: 0,
    })),
  } as RangeBundle;
}

function quoteMap(over: Partial<LiveQuote>): Map<string, LiveQuote> {
  return new Map([['005930', { code: '005930', price: 0, change_pct: null, change_won: null, ...over }]]);
}

describe('LiveCurrentPriceLine', () => {
  beforeEach(() => {
    cleanup();
    mockUseQuoteByCode.mockReturnValue(new Map());
  });

  it('creates one price line on the candle series at mount', () => {
    const s = makeSeriesMock();
    const paneSeries = new Map([['candle', s]]);
    mockUseQuoteByCode.mockReturnValue(quoteMap({ change_won: 500, change_pct: 0.7 }));
    render(<LiveCurrentPriceLine paneSeries={paneSeries as never} bundle={bundleWith([70000])} code="005930" />);
    expect(s.createPriceLine).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = (s.createPriceLine.mock.calls as any[][])[0]![0] as Record<string, unknown>;
    expect(opts).toMatchObject({ price: 70000, lineStyle: 2, axisLabelVisible: true });
    expect(opts.color).toBe(T.up); // 상승 → up 토큰
  });

  it('updates price via applyOptions without recreating the line', () => {
    const s = makeSeriesMock();
    const paneSeries = new Map([['candle', s]]);
    mockUseQuoteByCode.mockReturnValue(quoteMap({ change_won: 500, change_pct: 0.7 }));
    const { rerender } = render(
      <LiveCurrentPriceLine paneSeries={paneSeries as never} bundle={bundleWith([70000])} code="005930" />,
    );
    rerender(<LiveCurrentPriceLine paneSeries={paneSeries as never} bundle={bundleWith([70000, 71000])} code="005930" />);
    expect(s.createPriceLine).toHaveBeenCalledTimes(1);
    expect(s.priceLine.applyOptions).toHaveBeenLastCalledWith(expect.objectContaining({ price: 71000 }));
  });

  it('recolors via applyOptions when the quote direction flips', () => {
    const s = makeSeriesMock();
    const paneSeries = new Map([['candle', s]]);
    mockUseQuoteByCode.mockReturnValue(quoteMap({ change_won: 500, change_pct: 0.7 }));
    const { rerender } = render(
      <LiveCurrentPriceLine paneSeries={paneSeries as never} bundle={bundleWith([70000])} code="005930" />,
    );
    mockUseQuoteByCode.mockReturnValue(quoteMap({ change_won: -300, change_pct: -0.4 }));
    rerender(<LiveCurrentPriceLine paneSeries={paneSeries as never} bundle={bundleWith([70000])} code="005930" />);
    expect(s.priceLine.applyOptions).toHaveBeenLastCalledWith(expect.objectContaining({ color: T.down }));
  });

  it('does nothing when the candle series is absent', () => {
    const paneSeries = new Map();
    expect(() =>
      render(<LiveCurrentPriceLine paneSeries={paneSeries as never} bundle={bundleWith([70000])} code="005930" />),
    ).not.toThrow();
  });

  it('hides the line when candles become empty (model null)', () => {
    const s = makeSeriesMock();
    const paneSeries = new Map([['candle', s]]);
    mockUseQuoteByCode.mockReturnValue(quoteMap({ change_won: 500, change_pct: 0.7 }));
    const { rerender } = render(
      <LiveCurrentPriceLine paneSeries={paneSeries as never} bundle={bundleWith([70000])} code="005930" />,
    );
    rerender(<LiveCurrentPriceLine paneSeries={paneSeries as never} bundle={bundleWith([])} code="005930" />);
    expect(s.priceLine.applyOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ lineVisible: false, axisLabelVisible: false }),
    );
  });

  it('removes the price line on unmount', () => {
    const s = makeSeriesMock();
    const paneSeries = new Map([['candle', s]]);
    mockUseQuoteByCode.mockReturnValue(quoteMap({ change_won: 500, change_pct: 0.7 }));
    const { unmount } = render(
      <LiveCurrentPriceLine paneSeries={paneSeries as never} bundle={bundleWith([70000])} code="005930" />,
    );
    unmount();
    expect(s.removePriceLine).toHaveBeenCalledWith(s.priceLine);
  });
});
