import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import PriceLevelDotsOverlay from './PriceLevelDotsOverlay';
import { useChartPrefsStore } from '../state/chartPrefs';
import { createVirtualAxis } from '../util/virtualAxis';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { PaneId } from '../chart/drawing/types';
import type { PriceLevelHit, RangeBundle } from '../api/types';

const OPEN = Date.UTC(2026, 5, 24, 0, 0, 0);
const CLOSE = OPEN + 6.5 * 3_600_000;
const axis = createVirtualAxis(
  [{ date: '20260624', sessionOpenMs: OPEN, sessionCloseMs: CLOSE }],
  OPEN,
);

const hits: PriceLevelHit[] = [
  { date: '20260624', t_ms: OPEN + 60_000, price: 11_000, kind: 'vi', direction: 'upper', pct: 10 },
  { date: '20260624', t_ms: OPEN + 120_000, price: 13_000, kind: 'limit', direction: 'upper', pct: 30 },
];

function candleAt(ts: number) {
  return { ts_ms: ts, open: 10_000, high: 13_000, low: 9_000, close: 12_000, vol_a: 0, vol_b: 0 };
}

// 선의 양 끝은 **그 세션의 첫·마지막 렌더 캔들**이다(`sessionSpans`). 개장·마감
// 정각에 캔들이 있는 정상 케이스라 끝값이 세션 경계와 같다 — 아래 늦은-개장
// 케이스가 그 둘이 갈리는 쪽을 잰다.
const bundle = {
  price_level_hits: hits,
  segments: [{ date: '20260624', session_open_ms: OPEN, session_close_ms: CLOSE }],
  candles: [candleAt(OPEN), candleAt(OPEN + 180_000), candleAt(CLOSE)],
} as RangeBundle;

function makeChart(timeToCoordinate: (time: number) => number | null = () => 100) {
  return {
    timeScale: () => ({
      subscribeVisibleLogicalRangeChange: () => {},
      unsubscribeVisibleLogicalRangeChange: () => {},
      getVisibleRange: () => ({ from: OPEN / 1000, to: CLOSE / 1000 }),
      timeToCoordinate,
    }),
  } as never;
}

function paneSeries(priceToCoordinate: () => number | null = () => 50): PaneSeriesMap {
  return new Map([['candle' as PaneId, { priceToCoordinate } as never]]) as never;
}

function renderOverlay(opts?: {
  timeToCoordinate?: (time: number) => number | null;
  priceToCoordinate?: () => number | null;
  bundle?: RangeBundle;
}) {
  return render(
    <PriceLevelDotsOverlay
      chart={makeChart(opts?.timeToCoordinate)}
      bundle={opts?.bundle ?? bundle}
      axis={axis}
      paneSeries={paneSeries(opts?.priceToCoordinate)}
    />,
  );
}

describe('PriceLevelDotsOverlay', () => {
  beforeEach(() => {
    // 토글과 스타일이 같은 스토어 — 스타일이 지표 버킷/livePage 폴백에서
    // chartPrefs 로 합쳐졌다(#759 구현 중 발견).
    useChartPrefsStore.setState({
      viLimitPriceDotsEnabled: true,
      viLimitPriceLineColor: '#A855F7',
      viLimitPriceLineWidth: 4,
    });
  });
  afterEach(() => cleanup());

  it('renders VI and limit price lines with accessible labels', () => {
    renderOverlay();

    expect(screen.getByLabelText('VI +10% 11,000원 09:01')).toBeInTheDocument();
    expect(screen.getByLabelText('상한가 13,000원 09:02')).toBeInTheDocument();
  });

  it('renders nothing when the toggle is off', () => {
    useChartPrefsStore.setState({ viLimitPriceDotsEnabled: false });
    renderOverlay();

    expect(screen.queryByTestId('price-level-lines-overlay')).toBeNull();
  });

  it('skips lines when chart coordinates are null', () => {
    renderOverlay({ timeToCoordinate: () => null });

    expect(screen.getByTestId('price-level-lines-overlay')).toBeInTheDocument();
    expect(screen.queryByLabelText('VI +10% 11,000원 09:01')).toBeNull();
  });

  it('renders foreground price lines using the configured style', () => {
    renderOverlay({
      timeToCoordinate: (time) => {
        if (time === OPEN / 1000) return 10;
        if (time === CLOSE / 1000) return 210;
        return 100;
      },
    });

    expect(screen.getByTestId('price-level-lines-overlay')).toHaveStyle({
      zIndex: '20',
    });
    expect(screen.getByTestId('price-level-line-vi-upper-10')).toHaveStyle({
      left: '10px',
      width: '200px',
      height: '4px',
      backgroundColor: '#A855F7',
    });
  });

  // 결손 회귀 가드 — 종전엔 선의 양 끝을 **세션 개장/마감 정각**으로 구했다.
  // 그 시각의 캔들이 없는 날(005380 실측: 20260318 +6분, 20260602 +12분)은
  // `timeToCoordinate` 가 null 을 줘서 **그 히트가 통째로 사라졌다** — 날짜
  // 구분선과 같은 결함이다(#1361).
  //
  // mock 이 lwc 를 정확히 흉내 내는 것이 이 가드의 전부다: 데이터에 있는 시각에만
  // 좌표를 준다. 항상 좌표를 주는 mock 이면 개장 정각을 쓰든 첫 캔들을 쓰든 통과해
  // 버그를 원리적으로 재현할 수 없다.
  it('개장 정각에 캔들이 없는 날에도 선이 산다', () => {
    const lateFirst = OPEN + 12 * 60_000;
    const lateBundle = {
      ...bundle,
      candles: [candleAt(lateFirst), candleAt(lateFirst + 180_000), candleAt(CLOSE)],
    } as RangeBundle;
    const known = new Set(
      [lateFirst, lateFirst + 180_000, CLOSE].map((ms) => axis.toVirtual(ms) / 1000),
    );

    renderOverlay({
      bundle: lateBundle,
      timeToCoordinate: (time) => (known.has(time) ? 100 : null),
    });

    expect(screen.getByLabelText('VI +10% 11,000원 09:01')).toBeInTheDocument();
  });

  it('그 날 캔들이 아예 없으면 그 히트만 건너뛴다', () => {
    const emptyBundle = { ...bundle, candles: [] } as RangeBundle;
    renderOverlay({ bundle: emptyBundle });

    expect(screen.getByTestId('price-level-lines-overlay')).toBeInTheDocument();
    expect(screen.queryByLabelText('VI +10% 11,000원 09:01')).toBeNull();
  });
});
