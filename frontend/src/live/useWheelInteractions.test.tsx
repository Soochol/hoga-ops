import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { useRef } from 'react';
import type { IChartApi } from 'lightweight-charts';
import type { RangeBundle } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import { useWheelInteractions } from './useWheelInteractions';

// 훅이 실제로 사용하는 timeScale 표면만 흉내 낸다. 테스트별로 필요한
// 메서드만 override. width 1000 × minBarSpacing 0.5 → maxSpan 2000:
// 기본 케이스들의 요청 span(≤111)에는 플로어 클램프가 발동하지 않는다.
// timeToIndex 기본값 null → trueLast undefined → plain 앵커는 to-고정 폴백
// (lastBarIndex를 검증하는 테스트만 timeToIndex를 override한다).
function makeTs(over: Record<string, unknown> = {}) {
  return {
    getVisibleLogicalRange: vi.fn(() => ({ from: 0, to: 100 })),
    setVisibleLogicalRange: vi.fn(),
    coordinateToLogical: vi.fn(() => null),
    width: vi.fn(() => 1000),
    timeToIndex: vi.fn(() => null),
    ...over,
  };
}

function makeChart(ts: ReturnType<typeof makeTs>): IChartApi {
  return {
    timeScale: () => ts,
    options: () => ({ timeScale: { minBarSpacing: 0.5 } }),
  } as unknown as IChartApi;
}

// 최소 가짜 axis — 훅은 segments.length(>0 게이트)와 toVirtual만 쓴다.
// toVirtual은 항등(ms→virtual)으로 두고, 실제 인덱스 변환은 ts.timeToIndex
// mock이 결정한다(단위 테스트는 변환 합성이 아니라 배선 계약만 검증).
function makeAxis(hasSegments: boolean): VirtualAxis {
  return {
    segments: hasSegments ? [{}] : [],
    toVirtual: (ms: number) => ms,
  } as unknown as VirtualAxis;
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
    volume_distributions: [],
    investorPoints: [],
    ask_peaks: [],
  };
}

function Harness({
  chart,
  bundle,
  axis = makeAxis(false),
}: {
  chart: IChartApi | null;
  bundle: RangeBundle | null;
  axis?: VirtualAxis;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useWheelInteractions(chart, ref, bundle, axis);
  return <div data-testid="wheel-host" ref={ref} />;
}

// 실제 /live DOM 구조 재현: 차트 컨테이너와 DrawingOverlay는 live-chart-root의
// 형제다(LiveChartRoot.tsx). 그리기 도구 활성 / 그려진 선 hover 시 오버레이가
// pointer-events:auto가 되어 그 위 휠 이벤트를 가로챈다. 리스너가 차트 컨테이너
// 에만 붙으면 형제 오버레이의 휠은 도달하지 못한다(형제는 버블링 경로 밖) →
// preventDefault 누락 → 브라우저 페이지 줌. 리스너를 공통 부모에 붙여야 도달한다.
function OverlayHarness({
  chart,
  bundle,
  axis = makeAxis(false),
}: {
  chart: IChartApi | null;
  bundle: RangeBundle | null;
  axis?: VirtualAxis;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useWheelInteractions(chart, ref, bundle, axis);
  return (
    <div data-testid="chart-root">
      <div data-testid="wheel-host" ref={ref} />
      <div data-testid="drawing-overlay" />
    </div>
  );
}

// 주의: cancelable: true가 없으면 jsdom에서 preventDefault()가 no-op이라
// defaultPrevented를 단언할 수 없다 (스펙 Testing 절의 공통 Setup).
// bubbles: true — 실제 브라우저 wheel 이벤트는 버블링한다. 리스너는 차트
// 컨테이너의 부모(live-chart-root)에 붙으므로(형제 DrawingOverlay의 휠도 받기
// 위함), 자식 엘리먼트에서 dispatch한 이벤트가 부모 리스너에 도달하려면
// 버블링이 필요하다 (jsdom 합성 이벤트의 bubbles 기본값은 false).
function wheel(el: Element, init: WheelEventInit): WheelEvent {
  const e = new WheelEvent('wheel', { cancelable: true, bubbles: true, ...init });
  el.dispatchEvent(e);
  return e;
}

// deltaY=100 → factor = exp(0.1) ≈ 1.10517 (줌아웃 ~10.5%)
const FACTOR = Math.exp(100 * 0.001);

describe('useWheelInteractions', () => {
  it('plain wheel: 오른쪽 끝 고정 줌 — to 유지, from만 왼쪽으로 (bundle 없음)', () => {
    const ts = makeTs();
    const { getByTestId } = render(<Harness chart={makeChart(ts)} bundle={null} />);
    wheel(getByTestId('wheel-host'), { deltaY: 100 });
    expect(ts.setVisibleLogicalRange).toHaveBeenCalledTimes(1);
    const arg = ts.setVisibleLogicalRange.mock.calls[0][0] as { from: number; to: number };
    expect(arg.to).toBe(100);
    expect(arg.from).toBeCloseTo(100 - 100 * FACTOR, 6); // ≈ -10.517
  });

  it('plain wheel 줌인: 마지막 캔들의 합집합 인덱스(ts.timeToIndex)를 앵커로 전달', () => {
    // 훅은 마지막 캔들 ts_ms를 ts.timeToIndex로 변환해 trueLast를 얻는다
    // (candles.length-1이 아님 — 호가 합집합 skew 회피). timeToIndex가 85를
    // 돌려주면 range {0,100} 기준 anchor=min(100,85)=85. 줌인 factor=exp(-0.1):
    // from=85·(1−f)≈8.09, to=85+15·f≈98.57. to가 100으로 고정되지 않음 = 회귀 해소.
    const f = Math.exp(-0.1);
    const ts = makeTs({ timeToIndex: vi.fn(() => 85) });
    const { getByTestId } = render(
      <Harness chart={makeChart(ts)} bundle={makeBundle(86)} axis={makeAxis(true)} />,
    );
    wheel(getByTestId('wheel-host'), { deltaY: -100 });
    expect(ts.timeToIndex).toHaveBeenCalled(); // candles.length-1 대신 변환을 거쳤다
    const arg = ts.setVisibleLogicalRange.mock.calls[0][0] as { from: number; to: number };
    expect(arg.from).toBeCloseTo(85 * (1 - f), 6); // ≈ 8.089
    expect(arg.to).toBeCloseTo(85 + 15 * f, 6); // ≈ 98.573 (100 고정 아님)
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

  it('형제 DrawingOverlay 위 휠도 차트 줌으로 처리 — 브라우저 줌 방지 (회귀: 리스너 부모 부착)', () => {
    // 그리기 도구 활성 / 그려진 선 hover로 오버레이가 pointer-events:auto일 때
    // 그 위에서 휠을 돌리면, 오버레이는 차트 컨테이너의 형제이므로 리스너가
    // 컨테이너에만 붙어 있으면 이벤트가 도달하지 못해 preventDefault도
    // setVisibleLogicalRange도 일어나지 않고 브라우저 페이지 줌이 발동한다.
    // 리스너를 공통 부모에 부착하면 버블링으로 도달한다. setVisibleLogicalRange
    // 호출까지 단언해, preventDefault만 하고 차트 줌이 죽는 '죽은 구역'도 막는다.
    const ts = makeTs();
    const { getByTestId } = render(<OverlayHarness chart={makeChart(ts)} bundle={null} />);
    const e = wheel(getByTestId('drawing-overlay'), { deltaY: 100 });
    expect(e.defaultPrevented).toBe(true); // 브라우저 줌 차단
    expect(ts.setVisibleLogicalRange).toHaveBeenCalledTimes(1); // 차트 줌 동작
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

  it('bundle 교체 시 마지막 캔들 ms는 ref로 갱신 — 리스너 재부착 없음', () => {
    // timeToIndex mock = makeBundle의 ts_ms 공식 역산 → 캔들 인덱스(100개→99,
    // 50개→49). maxTo = trueLast + rightOffset(15). bundle 교체가 lastMsRef를
    // 갱신하므로 이벤트 시점 변환이 새 캔들(49)을 반영해야 한다.
    const BASE = 1_780_000_000_000;
    const ts = makeTs({
      timeToIndex: vi.fn((vt: number) => Math.round((vt * 1000 - BASE) / 60_000)),
    });
    const chart = makeChart(ts); // 동일 chart identity 유지 — 리스너 effect 재실행 방지
    const axis = makeAxis(true);
    const { getByTestId, rerender } = render(
      <Harness chart={chart} bundle={makeBundle(100)} axis={axis} />,
    );
    const host = getByTestId('wheel-host');
    const addSpy = vi.spyOn(host, 'addEventListener');
    rerender(<Harness chart={chart} bundle={makeBundle(50)} axis={axis} />); // trueLast 99 → 49
    // 재부착 없음: bundle 교체가 addEventListener('wheel', ...)를 다시 부르지 않는다.
    expect(addSpy.mock.calls.filter(([type]) => type === 'wheel')).toHaveLength(0);
    // 이벤트 시점 변환: trueLast 49 → maxTo 64(=49+15). range {0,100}, step +10 →
    // newTo 110 > 64 → 클램프 {from: -36, to: 64}. 교체 전 trueLast(99→maxTo 114)가
    // 스테일하면 110 < 114라 클램프 미발동 {from:10, to:110}으로 실패한다.
    wheel(host, { deltaY: 100, shiftKey: true });
    expect(ts.setVisibleLogicalRange).toHaveBeenCalledWith({ from: -36, to: 64 });
  });
});
