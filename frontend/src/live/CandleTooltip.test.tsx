import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import { Profiler, type ProfilerOnRenderCallback } from 'react';
import CandleTooltip from './CandleTooltip';
import { useChartPrefsStore } from '../state/chartPrefs';
import type { Candle } from '../api/types';

const dailyQueries = vi.hoisted(() => ({
  investor: vi.fn(), program: vi.fn(),
}));
vi.mock('../api/livePastInvestorNet', () => ({ useLivePastInvestorNet: dailyQueries.investor }));
vi.mock('../api/liveDailyProgramTrade', () => ({ useLiveDailyProgramTrade: dailyQueries.program }));

const origRAF = globalThis.requestAnimationFrame;
beforeEach(() => {
  dailyQueries.investor.mockReset().mockReturnValue({ data: undefined, isLoading: false, isError: false });
  dailyQueries.program.mockReset().mockReturnValue({ data: undefined, isLoading: false, isError: false });
  // rAF 동기 실행
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 0; }) as never;
  useChartPrefsStore.setState({
    candleTooltipEnabled: true,
    quoteTotalsIntraMax: false,
    ratioIntraMax: false,
  });
});
afterEach(() => { globalThis.requestAnimationFrame = origRAF; cleanup(); });

const C = (tsMs: number, o: number, h: number, l: number, c: number, va: number, vb = 0): Candle =>
  ({ ts_ms: tsMs, open: o, high: h, low: l, close: c, vol_a: va, vol_b: vb });

// identity axis: virtual ms == real ms, 전부 contained
const axis = {
  segments: [{}],
  toVirtual: (ms: number) => ms,
  toReal: (ms: number) => ms,
  contains: () => true,
} as never;

const baseCandles = [C(1_000_000, 100, 105, 99, 102, 10), C(1_060_000, 102, 108, 101, 107, 20)];

const bundle = {
  candles: baseCandles,
  quote_ratio: { bucket_ms: 60_000, points: [] },
} as never;

function makeChart(paneHeights: number[] = [400]) {
  let handler: ((p: unknown) => void) | null = null;
  const chart = {
    subscribeCrosshairMove: (h: (p: unknown) => void) => { handler = h; },
    unsubscribeCrosshairMove: () => { handler = null; },
    panes: () => paneHeights.map((h) => ({ getHeight: () => h })),
    chartElement: () => ({ clientWidth: 800, clientHeight: 400 }),
  } as never;
  return { chart, fire: (p: unknown) => act(() => { handler?.(p); }) };
}

function renderTip(chart: never) {
  return render(
    <CandleTooltip chart={chart} bundle={bundle} axis={axis} paneSeries={new Map() as never} timeframe="1m" />,
  );
}

describe('CandleTooltip', () => {
  it('토글 OFF 면 렌더 안 함', () => {
    useChartPrefsStore.setState({ candleTooltipEnabled: false });
    const { chart } = makeChart();
    renderTip(chart);
    expect(screen.queryByTestId('candle-tooltip')).toBeNull();
  });

  it('커서 이탈(point==null) 시 숨김', () => {
    const { chart, fire } = makeChart();
    renderTip(chart);
    fire({ point: { x: 100, y: 50 }, time: 1060 });
    expect(screen.getByTestId('candle-tooltip')).toBeInTheDocument();
    fire({ point: null, time: 1060 });
    expect(screen.queryByTestId('candle-tooltip')).toBeNull();
  });

  it('캔들 페인 위에서 OHLC 각 % + 직전대비 금액 + 거래량비 표시 (직전 봉 종가 102 기준)', () => {
    const { chart, fire } = makeChart();
    renderTip(chart);
    // time = axis.toVirtual(1_060_000)/1000 = 1060 ; y=50 ∈ pane0. prev.close=102.
    fire({ point: { x: 100, y: 50 }, time: 1060 });
    const tip = screen.getByTestId('candle-tooltip');
    expect(tip).toHaveTextContent('1970/01/01 09:17');
    expect(tip).toHaveTextContent('107');       // 종가
    expect(tip).toHaveTextContent('+0.00%');    // 시 % = 102/102
    expect(tip).toHaveTextContent('+5.88%');    // 고 % = 108/102
    expect(tip).toHaveTextContent('-0.98%');    // 저 % = 101/102
    expect(tip).toHaveTextContent('+4.90%');    // 종 % = 107/102
    expect(tip).toHaveTextContent('+5');        // 직전대비 금액 = 107-102 (원, % 없음)
    expect(tip).toHaveTextContent('200%');      // 거래량비 = 20/10*100
  });

  it('호버 캔들의 총잔량과 ask/bid ratio 를 k 단위로 표시한다', () => {
    const { chart, fire } = makeChart();
    const b = {
      candles: baseCandles,
      quote_ratio: {
        bucket_ms: 60_000,
        points: [{
          t: 1_060_000,
          ask_total: 32_500,
          bid_total: 900,
          ask_max: 32_500,
          bid_max: 900,
          imb_max_ask: 32_500,
          imb_max_bid: 900,
          band_pct: 0, tick: 0,
        }],
      },
    } as never;
    render(<CandleTooltip chart={chart} bundle={b} axis={axis} paneSeries={new Map() as never} timeframe="1m" />);
    fire({ point: { x: 100, y: 50 }, time: 1060 });
    const tip = screen.getByTestId('candle-tooltip');
    expect(tip).toHaveTextContent('총잔량매도 32.5k / 매수 0.9k');
    expect(tip).toHaveTextContent('A/B36.1x 매도우위');
  });

  it('분봉 내 최댓값 토글에 맞춰 총잔량과 A/B 기준을 바꾼다', () => {
    useChartPrefsStore.setState({
      quoteTotalsIntraMax: true,
      ratioIntraMax: true,
    });
    const { chart, fire } = makeChart();
    const b = {
      candles: baseCandles,
      quote_ratio: {
        bucket_ms: 60_000,
        points: [{
          t: 1_060_000,
          ask_total: 32_500,
          bid_total: 900,
          ask_max: 80_000,
          bid_max: 2_000,
          imb_max_ask: 500,
          imb_max_bid: 10_000,
          band_pct: 0, tick: 0,
        }],
      },
    } as never;
    render(<CandleTooltip chart={chart} bundle={b} axis={axis} paneSeries={new Map() as never} timeframe="1m" />);
    fire({ point: { x: 100, y: 50 }, time: 1060 });
    const tip = screen.getByTestId('candle-tooltip');
    expect(tip).toHaveTextContent('총잔량매도 80.0k / 매수 2.0k');
    expect(tip).toHaveTextContent('A/B0.1x 매수우위');
  });

  it('반올림으로 0.00% 가 되는 미세 양수 % 는 중립색(빨강 아님)', () => {
    // prev.close=30000, close=30001 → +0.0033% → 반올림 +0.00% → 중립이어야(색·텍스트 일치).
    const { chart, fire } = makeChart();
    const ps = new Map() as never;
    const b = { candles: [
      C(1_000_000, 30000, 30000, 30000, 30000, 10),
      C(1_060_000, 30600, 30900, 30300, 30001, 20),
    ] } as never;
    render(<CandleTooltip chart={chart} bundle={b} axis={axis} paneSeries={ps} timeframe="1m" />);
    fire({ point: { x: 100, y: 50 }, time: 1060 });
    const zero = screen.getByText('+0.00%'); // 종 행(유일)
    expect(zero).toHaveClass('text-fg-dim');
    expect(zero).not.toHaveClass('text-price-up');
  });

  it('첫 봉(직전 없음) → 직전대비·거래량비 —', () => {
    const { chart, fire } = makeChart();
    renderTip(chart);
    fire({ point: { x: 50, y: 50 }, time: 1000 }); // 첫 캔들 ts/1000
    const tip = screen.getByTestId('candle-tooltip');
    expect(tip).toHaveTextContent('—');
  });

  it('라이브 틱(bundle.candles 재생성)에도 호버 툴팁 유지 + 값 in-place 갱신', () => {
    // /live SSE 틱마다 bundle.candles 가 새 식별자로 재생성된다. 커서가 멈춰 있어도
    // (a) 구독이 끊겨 툴팁이 사라지면 안 되고, (b) 내용이 최신값으로 갱신돼야 한다.
    const { chart, fire } = makeChart();
    const ps = new Map() as never; // 렌더 간 안정적 paneSeries
    const b1 = { candles: [C(1_000_000, 100, 105, 99, 102, 10), C(1_060_000, 102, 108, 101, 107, 20)] } as never;
    const { rerender } = render(
      <CandleTooltip chart={chart} bundle={b1} axis={axis} paneSeries={ps} timeframe="1m" />,
    );
    fire({ point: { x: 100, y: 50 }, time: 1060 });
    expect(screen.getByTestId('candle-tooltip')).toHaveTextContent('107');
    // 같은 ts_ms, 형성 중인 봉의 종가·거래량만 갱신된 새 bundle 식별자
    const b2 = { candles: [C(1_000_000, 100, 105, 99, 102, 10), C(1_060_000, 102, 112, 101, 111, 40)] } as never;
    act(() => {
      rerender(<CandleTooltip chart={chart} bundle={b2} axis={axis} paneSeries={ps} timeframe="1m" />);
    });
    const tip = screen.getByTestId('candle-tooltip'); // 사라지지 않음(없으면 throw)
    expect(tip).toHaveTextContent('111');   // 갱신된 종가
    expect(tip).toHaveTextContent('400%');  // 40/10*100 갱신된 거래량비
  });

  it('비-캔들 페인(거래량 등) 위에서는 숨김 (paneIdAtY)', () => {
    // paneSeries 가 volume 시리즈를 pane index 1 에 매핑 → paneIdAtY 가 'volume' 반환.
    const { chart, fire } = makeChart([300, 100]); // pane0=candle, pane1=volume
    const ps = new Map([
      ['volume', { getPane: () => ({ paneIndex: () => 1 }) }],
    ]) as never;
    render(
      <CandleTooltip chart={chart} bundle={bundle} axis={axis} paneSeries={ps} timeframe="1m" />,
    );
    fire({ point: { x: 100, y: 50 }, time: 1060 });
    expect(screen.getByTestId('candle-tooltip')).toBeInTheDocument();
    fire({ point: { x: 100, y: 350 }, time: 1060 }); // y=350 ∈ pane1(volume)
    expect(screen.queryByTestId('candle-tooltip')).toBeNull();
  });

  it('axis 리베이스(가상시각 시프트)에도 같은 봉을 가리킨다 (ts_ms 키)', () => {
    const { chart, fire } = makeChart();
    const ps = new Map() as never;
    const { rerender } = render(
      <CandleTooltip chart={chart} bundle={bundle} axis={axis} paneSeries={ps} timeframe="1m" />,
    );
    fire({ point: { x: 100, y: 50 }, time: 1060 }); // 가상시각 1060 = ts 1_060_000
    expect(screen.getByTestId('candle-tooltip')).toHaveTextContent('107');
    // 과거확장 리베이스: toVirtual 이 시프트(가상시각 전부 달라짐), ts_ms 는 불변
    const shifted = {
      segments: [{}],
      toVirtual: (ms: number) => ms + 999_000_000,
      toReal: (ms: number) => ms,
      contains: () => true,
    } as never;
    act(() => {
      rerender(<CandleTooltip chart={chart} bundle={bundle} axis={shifted} paneSeries={ps} timeframe="1m" />);
    });
    // 커서 안 움직였지만 ts_ms 키로 같은 봉 유지(가상시각 키였다면 사라졌을 것)
    expect(screen.getByTestId('candle-tooltip')).toHaveTextContent('107');
  });

  it('같은 캔들 안 위치 이동은 React 리렌더 없이 DOM 위치만 갱신한다', () => {
    const { chart, fire } = makeChart();
    const ps = new Map() as never;
    let updates = 0;
    const onRender: ProfilerOnRenderCallback = (_id, phase) => {
      if (phase === 'update') updates += 1;
    };

    const { rerender } = render(
      <Profiler id="candle-tooltip" onRender={onRender}>
        <CandleTooltip chart={chart} bundle={bundle} axis={axis} paneSeries={ps} timeframe="1m" />
      </Profiler>,
    );

    fire({ point: { x: 100, y: 50 }, time: 1060 });
    const afterFirstHover = updates;
    const tip = screen.getByTestId('candle-tooltip');
    const firstLeft = tip.style.left;

    fire({ point: { x: 180, y: 70 }, time: 1060 });

    expect(updates).toBe(afterFirstHover);
    expect(tip.style.left).not.toBe(firstLeft);
    const latestLeft = tip.style.left;

    rerender(
      <Profiler id="candle-tooltip" onRender={onRender}>
        <CandleTooltip chart={chart} bundle={bundle} axis={axis} paneSeries={ps} timeframe="1m" />
      </Profiler>,
    );
    expect(tip.style.left).toBe(latestLeft);
  });
});


describe('daily candle details independent of indicator legends', () => {
  const day = Date.UTC(2026, 8, 15);
  const yesterday = day - 86_400_000;
  const candles = [C(yesterday, 100, 105, 99, 102, 10), {
    ...C(day, 102, 108, 101, 107, 20), trade_value_won: 123_450_000_000,
  }];
  function mountDaily(timeframe: 'D' | 'W' = 'D') {
    const { chart, fire } = makeChart();
    render(<CandleTooltip chart={chart} bundle={{ code: '005930', candles, quote_ratio: { points: [] } } as never}
      axis={axis} paneSeries={new Map() as never} timeframe={timeframe} />);
    fire({ time: day / 1000, point: { x: 40, y: 40 } });
    return fire;
  }
  it('shows turnover and daily net quantities without indicator panes', () => {
    dailyQueries.investor.mockReturnValue({ data: { code: '005930', unit: 'qty_shares', trade_side: 'net',
      points: [{ t_ms: day, institution_net: 123456, foreign_net: -45678 }] } });
    dailyQueries.program.mockReturnValue({ data: { code: '005930', points: [{ t_ms: day, net_qty: 12345, buy_qty: 99999 }] } });
    mountDaily();
    const tip = screen.getByTestId('candle-tooltip');
    expect(tip).toHaveTextContent('거래대금1,234.5억');
    expect(tip).toHaveTextContent('기관 순매수+123,456주');
    expect(tip).toHaveTextContent('외인 순매수-45,678주');
    expect(tip).toHaveTextContent('프로그램 순매수+12,345주');
    expect(dailyQueries.investor).toHaveBeenCalledWith('005930', '20260914', '20260915', 'qty', 'net');
  });
  it('never fills a missing date with the previous day and preserves zero', () => {
    dailyQueries.investor.mockReturnValue({ data: { code: '005930', points: [{ t_ms: yesterday, institution_net: 0, foreign_net: 100 }] } });
    const fire = mountDaily();
    expect(screen.getByTestId('daily-candle-details')).toHaveTextContent('기관 순매수—');
    fire({ time: yesterday / 1000, point: { x: 40, y: 40 } });
    expect(screen.getByTestId('daily-candle-details')).toHaveTextContent('기관 순매수0주');
    expect(screen.getByTestId('daily-candle-details')).toHaveTextContent('거래대금—');
  });
  it('does not show stale data from another stock or a buy-only response', () => {
    dailyQueries.investor.mockReturnValue({ data: { code: '005930', trade_side: 'buy', points: [{ t_ms: day, institution_net: 999, foreign_net: 999 }] } });
    dailyQueries.program.mockReturnValue({ data: { code: '000660', points: [{ t_ms: day, net_qty: 888 }] } });
    mountDaily();
    expect(screen.getByTestId('daily-candle-details')).not.toHaveTextContent('999');
    expect(screen.getByTestId('daily-candle-details')).not.toHaveTextContent('888');
  });
  it('shows loading and failure separately from missing values', () => {
    dailyQueries.investor.mockReturnValue({ isLoading: true });
    dailyQueries.program.mockReturnValue({ isError: true });
    mountDaily();
    expect(screen.getByTestId('daily-candle-details')).toHaveTextContent('기관 순매수불러오는 중');
    expect(screen.getByTestId('daily-candle-details')).toHaveTextContent('프로그램 순매수조회 실패');
  });
  it('repositions when asynchronously loaded rows increase tooltip height', () => {
    const original = globalThis.ResizeObserver;
    let resize: (() => void) | undefined;
    globalThis.ResizeObserver = class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect() {}
    } as never;
    try {
      const fire = mountDaily();
      fire({ time: day / 1000, point: { x: 790, y: 390 } });
      const tip = screen.getByTestId('candle-tooltip');
      Object.defineProperties(tip, { offsetWidth: { value: 300 }, offsetHeight: { value: 270 } });
      act(() => resize?.());
      expect(tip.style.left).toBe('476px');
      expect(tip.style.top).toBe('108px');
    } finally {
      cleanup();
      globalThis.ResizeObserver = original;
    }
  });
  it('does not query daily details on weekly candles or when the tooltip is off', () => {
    mountDaily('W');
    expect(dailyQueries.investor).not.toHaveBeenCalled();
    cleanup();
    useChartPrefsStore.setState({ candleTooltipEnabled: false });
    mountDaily();
    expect(dailyQueries.program).not.toHaveBeenCalled();
  });
});
