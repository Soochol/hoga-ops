import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
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

const bundle = {
  candles: [C(1_000_000, 100, 105, 99, 102, 10), C(1_060_000, 102, 108, 101, 107, 20)],
} as never;

function makeChart() {
  let handler: ((p: unknown) => void) | null = null;
  const chart = {
    subscribeCrosshairMove: (h: (p: unknown) => void) => { handler = h; },
    unsubscribeCrosshairMove: () => { handler = null; },
    panes: () => [{ getHeight: () => 400 }],
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
    fire({ point: null, time: 1060 });
    expect(screen.queryByTestId('candle-tooltip')).toBeNull();
  });

  it('캔들 페인 위에서 OHLC·직전대비·거래량비 표시', () => {
    const { chart, fire } = makeChart();
    renderTip(chart);
    // time = axis.toVirtual(1_060_000)/1000 = 1060 ; y=50 ∈ pane0
    fire({ point: { x: 100, y: 50 }, time: 1060 });
    const tip = screen.getByTestId('candle-tooltip');
    expect(tip).toHaveTextContent('107');   // 종가
    expect(tip).toHaveTextContent('+5');    // 직전대비 = 107-102
    expect(tip).toHaveTextContent('200%');  // 거래량비 = 20/10*100
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
});
