import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import { Profiler, type ProfilerOnRenderCallback } from 'react';
import CandleTooltip from './CandleTooltip';
import { useChartPrefsStore } from '../state/chartPrefs';
import type { Candle } from '../api/types';

const origRAF = globalThis.requestAnimationFrame;
beforeEach(() => {
  // rAF 동기 실행
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 0; }) as never;
  useChartPrefsStore.setState({ candleTooltipEnabled: true });
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
        }],
      },
    } as never;
    render(<CandleTooltip chart={chart} bundle={b} axis={axis} paneSeries={new Map() as never} timeframe="1m" />);
    fire({ point: { x: 100, y: 50 }, time: 1060 });
    const tip = screen.getByTestId('candle-tooltip');
    expect(tip).toHaveTextContent('총잔량매도 32.5k / 매수 0.9k');
    expect(tip).toHaveTextContent('A/B36.1x 매도우위');
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
