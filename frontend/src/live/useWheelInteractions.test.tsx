import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { useRef } from 'react';
import type { IChartApi } from 'lightweight-charts';
import type { RangeBundle } from '../api/types';
import { useWheelInteractions } from './useWheelInteractions';

// 훅이 실제로 사용하는 timeScale 표면만 흉내 낸다. 테스트별로 필요한
// 메서드만 override. width 1000 × minBarSpacing 0.5 → maxSpan 2000:
// 기본 케이스들의 요청 span(≤111)에는 플로어 클램프가 발동하지 않는다.
function makeTs(over: Record<string, unknown> = {}) {
  return {
    getVisibleLogicalRange: vi.fn(() => ({ from: 0, to: 100 })),
    setVisibleLogicalRange: vi.fn(),
    coordinateToLogical: vi.fn(() => null),
    width: vi.fn(() => 1000),
    ...over,
  };
}

function makeChart(ts: ReturnType<typeof makeTs>): IChartApi {
  return {
    timeScale: () => ts,
    options: () => ({ timeScale: { minBarSpacing: 0.5 } }),
  } as unknown as IChartApi;
}

// RangeBundle 최소 픽스처 — candles 길이만 의미 있다 (maxTo = length - 1).
function makeBundle(candleCount: number): RangeBundle {
  return {
    code: '005930',
    from_date: '20260608',
    to_date: '20260608',
    bucket_ms: 60_000,
    segments: [
      {
        date: '20260608',
        session_open_ms: 1_780_000_000_000,
        session_close_ms: 1_780_023_400_000,
        source: 'kis_live',
      },
    ],
    candles: Array.from({ length: candleCount }, (_, i) => ({
      ts_ms: 1_780_000_000_000 + i * 60_000,
      open: 100, high: 101, low: 99, close: 100, vol_a: 1, vol_b: 0,
    })),
    quote_ratio: { bucket_ms: 60_000, points: [] },
    fill_strength: { bucket_ms: 60_000, points: [] },
    volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_by_day: [],
    investorPoints: [],
  };
}

function Harness({ chart, bundle }: { chart: IChartApi | null; bundle: RangeBundle | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useWheelInteractions(chart, ref, bundle);
  return <div data-testid="wheel-host" ref={ref} />;
}

// 주의: cancelable: true가 없으면 jsdom에서 preventDefault()가 no-op이라
// defaultPrevented를 단언할 수 없다 (스펙 Testing 절의 공통 Setup).
function wheel(el: Element, init: WheelEventInit): WheelEvent {
  const e = new WheelEvent('wheel', { cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
}

// deltaY=100 → factor = exp(0.1) ≈ 1.10517 (줌아웃 ~10.5%)
const FACTOR = Math.exp(100 * 0.001);

describe('useWheelInteractions', () => {
  it('plain wheel: 오른쪽 끝 고정 줌 — to 유지, from만 왼쪽으로', () => {
    const ts = makeTs();
    const { getByTestId } = render(<Harness chart={makeChart(ts)} bundle={null} />);
    wheel(getByTestId('wheel-host'), { deltaY: 100 });
    expect(ts.setVisibleLogicalRange).toHaveBeenCalledTimes(1);
    const arg = ts.setVisibleLogicalRange.mock.calls[0][0] as { from: number; to: number };
    expect(arg.to).toBe(100);
    expect(arg.from).toBeCloseTo(100 - 100 * FACTOR, 6); // ≈ -10.517
  });

  it('ctrl wheel: 커서 앵커 줌 — 양변이 앵커(50) 기준 확장', () => {
    const ts = makeTs({ coordinateToLogical: vi.fn(() => 50) });
    const { getByTestId } = render(<Harness chart={makeChart(ts)} bundle={null} />);
    wheel(getByTestId('wheel-host'), { deltaY: 100, ctrlKey: true, clientX: 50 });
    expect(ts.coordinateToLogical).toHaveBeenCalledWith(50);
    const arg = ts.setVisibleLogicalRange.mock.calls[0][0] as { from: number; to: number };
    expect(arg.from).toBeCloseTo(50 - 50 * FACTOR, 6); // ≈ -5.259
    expect(arg.to).toBeCloseTo(50 + 50 * FACTOR, 6);   // ≈ 105.259
  });

  it('shift wheel: 스팬 유지 팬 (+스팬의 10%)', () => {
    const ts = makeTs();
    const { getByTestId } = render(<Harness chart={makeChart(ts)} bundle={null} />);
    wheel(getByTestId('wheel-host'), { deltaY: 100, shiftKey: true });
    // bundle=null → maxTo=Infinity → 클램프 미발동 (스펙 공통 Setup).
    expect(ts.setVisibleLogicalRange).toHaveBeenCalledWith({ from: 10, to: 110 });
  });

  it('range가 있으면 preventDefault로 페이지 스크롤 차단', () => {
    const ts = makeTs();
    const { getByTestId } = render(<Harness chart={makeChart(ts)} bundle={null} />);
    const e = wheel(getByTestId('wheel-host'), { deltaY: 100 });
    expect(e.defaultPrevented).toBe(true);
  });

  it('로드 전(visible range null): no-op + 페이지 스크롤 미차단', () => {
    const ts = makeTs({ getVisibleLogicalRange: vi.fn(() => null) });
    const { getByTestId } = render(<Harness chart={makeChart(ts)} bundle={null} />);
    const e = wheel(getByTestId('wheel-host'), { deltaY: 100 });
    expect(ts.setVisibleLogicalRange).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it('unmount 시 리스너 해제', () => {
    const ts = makeTs();
    const { getByTestId, unmount } = render(<Harness chart={makeChart(ts)} bundle={null} />);
    const host = getByTestId('wheel-host');
    unmount();
    wheel(host, { deltaY: 100 });
    expect(ts.setVisibleLogicalRange).not.toHaveBeenCalled();
  });

  it('Firefox 라인 단위 휠(deltaMode=LINE): deltaY를 ×32 환산해 픽셀 모드와 동일 줌', () => {
    const ts = makeTs();
    const { getByTestId } = render(<Harness chart={makeChart(ts)} bundle={null} />);
    // 3.125 라인 × 32 = 100 픽셀 상당 → 픽셀 모드 deltaY=100과 동일 결과여야 한다.
    wheel(getByTestId('wheel-host'), { deltaY: 3.125, deltaMode: WheelEvent.DOM_DELTA_LINE });
    const arg = ts.setVisibleLogicalRange.mock.calls[0][0] as { from: number; to: number };
    expect(arg.to).toBe(100);
    expect(arg.from).toBeCloseTo(100 - 100 * FACTOR, 6); // 환산 없으면 ≈ -0.31로 실패
  });

  it('줌아웃 플로어: maxSpan(=width/minBarSpacing) 초과 요청은 앵커 보존 클램프로 전달', () => {
    // width 52.5 × minBarSpacing 0.5 → maxSpan 105. ctrl 줌아웃 요청 span
    // ≈110.5 > 105 → 앵커(50, 비율 0.5) 보존 클램프 {-2.5, 102.5}.
    // 클램프가 없으면 {≈-5.26, ≈105.26}이 그대로 전달되어 실패한다.
    const ts = makeTs({ width: vi.fn(() => 52.5), coordinateToLogical: vi.fn(() => 50) });
    const { getByTestId } = render(<Harness chart={makeChart(ts)} bundle={null} />);
    wheel(getByTestId('wheel-host'), { deltaY: 100, ctrlKey: true, clientX: 50 });
    const arg = ts.setVisibleLogicalRange.mock.calls[0][0] as { from: number; to: number };
    expect(arg.from).toBeCloseTo(-2.5, 9);
    expect(arg.to).toBeCloseTo(102.5, 9);
  });

  it('bundle 교체 시 maxTo는 ref로 갱신 — 리스너 재부착 없음', () => {
    const ts = makeTs();
    const chart = makeChart(ts); // 동일 chart identity 유지 — 리스너 effect 재실행 방지
    const { getByTestId, rerender } = render(<Harness chart={chart} bundle={makeBundle(100)} />);
    const host = getByTestId('wheel-host');
    const addSpy = vi.spyOn(host, 'addEventListener');
    rerender(<Harness chart={chart} bundle={makeBundle(50)} />); // maxTo 114 → 64 (49 + rightOffset 15)
    // 재부착 없음: bundle 교체가 addEventListener('wheel', ...)를 다시 부르지 않는다.
    expect(addSpy.mock.calls.filter(([type]) => type === 'wheel')).toHaveLength(0);
    // 이벤트 시점에 ref에서 새 maxTo(64 = 49 + rightOffset 15)를 읽는다:
    // range {0,100}, step +10 → newTo 110 > 64 → 클램프 {from: 64-100, to: 64}.
    // 교체 전 maxTo(114 = 99+15)가 스테일하게 남았다면 110 < 114라 클램프가
    // 발동하지 않아 {from: 10, to: 110}이 되어 실패한다.
    wheel(host, { deltaY: 100, shiftKey: true });
    expect(ts.setVisibleLogicalRange).toHaveBeenCalledWith({ from: -36, to: 64 });
  });
});
