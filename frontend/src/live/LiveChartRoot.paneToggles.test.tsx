import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ComponentProps, ReactNode } from 'react';

// jsdom lacks ResizeObserver — stub before the component module loads.
if (typeof window !== 'undefined' && !window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// Capture which pane specs LiveChartRoot actually mounts. This closes the
// wiring blind spot: paneSpecsForTimeframe is unit-tested in isolation, but
// "store toggle → paneToggles → the pane set that reaches RangeSeriesPane" was
// never asserted end-to-end. RangeSeriesPane renders null in jsdom (imperative
// lightweight-charts wrapper), so we replace it with a prop-capturing stub.
const { mounted, paneBundles, paneContexts, paneOrderKeys, candleTooltipProps, askPeakMounts, bidPeakMounts, dockedLabelMounts, chartInstances } = vi.hoisted(() => ({
  mounted: [] as string[],
  paneBundles: [] as Array<{ name: string; bundle: unknown }>,
  paneContexts: [] as Array<{ name: string; contextOverride: unknown }>,
  paneOrderKeys: [] as Array<{
    name: string;
    precedingPaneKey: string;
    paneIndex: number;
    groupPaneIds: readonly string[] | undefined;
    groupAxisShared: boolean | undefined;
  }>,
  candleTooltipProps: [] as Array<{ bundle: unknown; quoteBundle?: unknown }>,
  askPeakMounts: [] as string[],
  bidPeakMounts: [] as string[],
  dockedLabelMounts: [] as string[],
  chartInstances: [] as Array<{
    remove: ReturnType<typeof vi.fn>;
    timeScaleApi: {
      subscribeVisibleLogicalRangeChange: ReturnType<typeof vi.fn>;
      unsubscribeVisibleLogicalRangeChange: ReturnType<typeof vi.fn>;
      subscribeVisibleTimeRangeChange: ReturnType<typeof vi.fn>;
      fitContent: ReturnType<typeof vi.fn>;
      setVisibleLogicalRange: ReturnType<typeof vi.fn>;
    };
  }>,
}));
vi.mock('../chart/RangeSeriesPane', () => ({
  default: (props: {
    spec: { name: string };
    bundle: unknown;
    contextOverride?: unknown;
    precedingPaneKey: string;
    paneIndex: number;
    groupPaneIds?: readonly string[];
    groupAxisShared?: boolean;
  }) => {
    mounted.push(props.spec.name);
    paneBundles.push({ name: props.spec.name, bundle: props.bundle });
    paneContexts.push({ name: props.spec.name, contextOverride: props.contextOverride });
    paneOrderKeys.push({
      name: props.spec.name,
      precedingPaneKey: props.precedingPaneKey,
      paneIndex: props.paneIndex,
      groupPaneIds: props.groupPaneIds,
      groupAxisShared: props.groupAxisShared,
    });
    return null;
  },
}));

vi.mock('./CandleTooltip', () => ({
  default: (props: { bundle: unknown; quoteBundle?: unknown }) => {
    candleTooltipProps.push({ bundle: props.bundle, quoteBundle: props.quoteBundle });
    return null;
  },
}));

// 매도·매수 오버레이는 2026-08-23 부터 **한 컴포넌트**다(`side` prop). 마운트 기록을
// side 로 갈라 종전 두 카운터를 그대로 쓴다.
vi.mock('./LivePeakWallSegments', () => ({
  default: ({ side }: { side: 'ask' | 'bid' }) => {
    (side === 'ask' ? askPeakMounts : bidPeakMounts).push('mounted');
    return null;
  },
}));

vi.mock('./LivePeakWallDockedLabels', () => ({
  default: () => {
    dockedLabelMounts.push('mounted');
    return null;
  },
}));

vi.mock('lightweight-charts', async () => {
  const mod = await vi.importActual<typeof import('lightweight-charts')>('lightweight-charts');
  return {
    ...mod,
    createChartEx: vi.fn(() => {
      const timeScaleApi = {
        subscribeVisibleTimeRangeChange: vi.fn(), unsubscribeVisibleTimeRangeChange: vi.fn(),
        subscribeVisibleLogicalRangeChange: vi.fn(), unsubscribeVisibleLogicalRangeChange: vi.fn(),
        applyOptions: vi.fn(), fitContent: vi.fn(), scrollToRealTime: vi.fn(), scrollToPosition: vi.fn(),
        setVisibleLogicalRange: vi.fn(), getVisibleRange: vi.fn(() => null), setVisibleRange: vi.fn(),
        width: vi.fn(() => 900), timeToIndex: vi.fn(() => null),
        timeToCoordinate: vi.fn(() => null),
      };
      const chart = {
        addSeries: vi.fn(() => ({
          setData: vi.fn(), update: vi.fn(), removeSeries: vi.fn(), applyOptions: vi.fn(),
          priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
          createPriceLine: vi.fn(() => ({ applyOptions: vi.fn() })),
          removePriceLine: vi.fn(), attachPrimitive: vi.fn(), detachPrimitive: vi.fn(), setMarkers: vi.fn(),
        })),
        removeSeries: vi.fn(),
        timeScale: vi.fn(() => timeScaleApi),
        panes: vi.fn(() => []),
        remove: vi.fn(), resize: vi.fn(), applyOptions: vi.fn(),
        subscribeCrosshairMove: vi.fn(), unsubscribeCrosshairMove: vi.fn(),
        chartElement: vi.fn(() => ({ clientWidth: 0, clientHeight: 0 })),
        timeScaleApi,
      };
      chartInstances.push(chart);
      return chart;
    }),
  };
});

import { LiveChartRoot } from './LiveChartRoot';
import { useLivePageStore } from '../state/livePage';
import { mergePaneIntoGroup, paneAxisShareKey, paneGroupsFromOrder } from '../chart/paneGroups';
import type { PaneId } from '../chart/drawing/types';
import { DEFAULT_PREFS, useChartPrefsStore } from '../state/chartPrefs';
import type { RangeBundle } from '../api/types';

const DEFAULT_BUNDLE: RangeBundle = {
  code: '005930',
  from_date: '20260527',
  to_date: '20260527',
  bucket_ms: 60_000,
  segments: [
    { date: '20260527', session_open_ms: 1748275200000, session_close_ms: 1748298600000, source: 'kiwoom_live' },
  ],
  candles: [],
  quote_ratio: { bucket_ms: 60_000, points: [] },
  fill_strength: { bucket_ms: 60_000, points: [] },
  volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
  volume_profile_by_day: [],
  volume_distributions: [],
  investorPoints: [],
  ask_peaks: [],
  broker_late_entries: [],
};

const CALENDAR_BUNDLE: RangeBundle = {
  ...DEFAULT_BUNDLE,
  bucket_ms: 7 * 24 * 60 * 60 * 1000,
  candles: [
    { ts_ms: 1781222400000, open: 1, high: 2, low: 1, close: 2, vol_a: 10, vol_b: 0 },
    { ts_ms: 1781827200000, open: 2, high: 3, low: 2, close: 3, vol_a: 11, vol_b: 0 },
  ],
};

const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

function renderAt(timeframe: '1m' | 'D' | 'W' | 'M', props: Partial<ComponentProps<typeof LiveChartRoot>> = {}) {
  return render(
    <LiveChartRoot
      code="005930"
      timeframe={timeframe}
      bundle={DEFAULT_BUNDLE}
      clampEngaged={false}
      isPastCandlesLoading={false}
      {...props}
    />,
    { wrapper },
  );
}

describe('LiveChartRoot — pane 토글 배선 (store → 마운트된 pane 집합)', () => {
  beforeEach(() => {
    mounted.length = 0;
    paneOrderKeys.length = 0;
    paneBundles.length = 0;
    paneContexts.length = 0;
    candleTooltipProps.length = 0;
    askPeakMounts.length = 0;
    bidPeakMounts.length = 0;
    dockedLabelMounts.length = 0;
    chartInstances.length = 0;
    // Deterministic baseline: all togglable panes ON, investor OFF.
    useLivePageStore.setState({
      historicalFromDate: null,
      volumeEnabled: true,
      quoteTotalsEnabled: true,
      ratioEnabled: true,
      fillStrengthEnabled: true,
      programTradeEnabled: true,
      foreignNetEnabled: false,
      institutionNetEnabled: false,
      peakWallPaneEnabled: false,
      indicatorsByTimeframe: {},
      indicatorTimeframe: '1m',
      // ⚠ paneOrder 도 기준선에 포함한다 — 종전엔 리셋이 없어 「pane 순서를 바꾸면…」
      // 테스트의 스왑이 뒤 테스트로 샜다(뒤 테스트들이 우연히 통과했을 뿐).
      // paneGroups(레이아웃 원본)도 같은 이유로 동기 리셋 — 병합 테스트의 그룹이
      // 뒤 테스트로 새면 마운트 순서 단언이 전부 흔들린다.
      paneOrder: [
        'candle', 'volume', 'quote-totals', 'peak-wall', 'ratio',
        'fill-strength', 'program-trade', 'investor-foreign', 'investor-institution',
      ],
      paneGroups: paneGroupsFromOrder([
        'candle', 'volume', 'quote-totals', 'peak-wall', 'ratio',
        'fill-strength', 'program-trade', 'investor-foreign', 'investor-institution',
      ]),
      paneAxisShare: {},
    });
    useChartPrefsStore.getState().setToggle('volumeFillStrengthCumulative', false);
  });

  it('기본(전부 ON) 1m → 6 pane 마운트', () => {
    renderAt('1m');
    expect(mounted).toEqual(['candle', 'volume', 'quote-totals', 'ratio', 'fill-strength', 'program-trade']);
  });

  it('각 pane 에 자기 앞 pane 이름 시퀀스를 넘긴다 (재생성 참여 범위의 근거)', () => {
    renderAt('1m');
    // 캔들은 항상 `''` — 그래서 순서가 바뀌어도 재생성에서 자동으로 빠진다(고정 pane).
    // 나머지는 누적 시퀀스. 이 값이 `RangeSeriesPane` lifecycle dep 이므로, 순서가
    // 바뀌면 "밑에서 인덱스가 밀리는" pane 들이 정확히 전부 참여한다.
    expect(paneOrderKeys.map(({ name, precedingPaneKey }) => ({ name, precedingPaneKey }))).toEqual([
      { name: 'candle', precedingPaneKey: '' },
      { name: 'volume', precedingPaneKey: 'candle' },
      { name: 'quote-totals', precedingPaneKey: 'candle|volume' },
      { name: 'ratio', precedingPaneKey: 'candle|volume|quote-totals' },
      { name: 'fill-strength', precedingPaneKey: 'candle|volume|quote-totals|ratio' },
      { name: 'program-trade', precedingPaneKey: 'candle|volume|quote-totals|ratio|fill-strength' },
    ]);
    // 전 그룹 싱글턴이면 paneIndex 는 종전과 같은 순번이다(병합 무영향 회귀선).
    expect(paneOrderKeys.map((p) => p.paneIndex)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('병합 그룹은 같은 paneIndex 를 공유하고 아래 pane 의 앞 시퀀스에 구성이 실린다', () => {
    // ratio 를 volume 그룹에 병합 — 멤버 둘이 pane 하나(index 1)를 공유하고,
    // 그 아래 pane 들의 시퀀스에는 그룹 **구성**('volume,ratio')이 들어간다.
    const singles = paneGroupsFromOrder(['candle', 'volume', 'ratio', 'quote-totals', 'fill-strength', 'program-trade', 'investor-foreign', 'investor-institution'] as PaneId[]);
    useLivePageStore.setState({
      paneGroups: mergePaneIntoGroup(singles, 'ratio', 'volume'),
    });
    renderAt('1m');
    const byName = new Map(paneOrderKeys.map((p) => [p.name, p]));
    expect(byName.get('volume')?.paneIndex).toBe(1);
    expect(byName.get('ratio')?.paneIndex).toBe(1);
    // 같은 그룹 = 같은 앞 시퀀스 + 같은 멤버 목록(스케일 격리의 입력).
    expect(byName.get('volume')?.precedingPaneKey).toBe('candle');
    expect(byName.get('ratio')?.precedingPaneKey).toBe('candle');
    expect(byName.get('volume')?.groupPaneIds).toEqual(['volume', 'ratio']);
    expect(byName.get('ratio')?.groupPaneIds).toEqual(['volume', 'ratio']);
    // 아래 pane 은 인덱스가 하나 당겨지고 시퀀스에 그룹 구성이 들어간다.
    expect(byName.get('quote-totals')?.paneIndex).toBe(2);
    expect(byName.get('quote-totals')?.precedingPaneKey).toBe('candle|volume,ratio');
  });

  it('y축 공유 오버라이드가 그룹에 전달되고 아래 pane 의 앞 시퀀스에도 실린다', () => {
    // volume+ratio 병합(비화이트리스트 → 기본 분리) + 수동 공유 오버라이드.
    const singles = paneGroupsFromOrder(['candle', 'volume', 'ratio', 'quote-totals', 'peak-wall', 'fill-strength', 'program-trade', 'investor-foreign', 'investor-institution'] as PaneId[]);
    useLivePageStore.setState({
      paneGroups: mergePaneIntoGroup(singles, 'ratio', 'volume'),
      paneAxisShare: { [paneAxisShareKey(['volume', 'ratio'])]: true },
    });
    renderAt('1m');
    const byName = new Map(paneOrderKeys.map((p) => [p.name, p]));
    expect(byName.get('volume')?.groupAxisShared).toBe(true);
    expect(byName.get('ratio')?.groupAxisShared).toBe(true);
    // 플립이 시리즈 재생성을 부르므로(priceScaleId 는 생성 시 옵션) 아래 pane 의
    // 앞 시퀀스 구성에 공유 플래그가 실린다 — #1381 메커니즘 방지의 그룹판.
    expect(byName.get('quote-totals')?.precedingPaneKey).toBe('candle|volume,ratio!shared');
    // 싱글턴 pane 은 항상 false.
    expect(byName.get('quote-totals')?.groupAxisShared).toBe(false);
  });

  it('pane 순서를 바꾸면 그 아래 pane 의 앞 시퀀스도 바뀐다', () => {
    // quote-totals ↔ ratio 를 맞바꾸면, 두 pane 뿐 아니라 **그 아래** pane 들의 앞
    // 시퀀스도 달라져야 한다. 안 그러면 아래 pane 이 재생성에 참여하지 않아 lwc 가
    // 인덱스를 당기는 사이 series 가 남의 pane 으로 합쳐진다.
    // 레이아웃 원본은 paneGroups 다(paneOrder 는 투영) — setState 직접 주입이라
    // 액션이 해 주는 동기화를 여기서 손으로 한다.
    const reordered: PaneId[] = ['candle', 'volume', 'ratio', 'quote-totals', 'fill-strength', 'program-trade', 'investor-foreign', 'investor-institution'];
    useLivePageStore.setState({
      paneOrder: reordered,
      paneGroups: paneGroupsFromOrder(reordered),
    });
    renderAt('1m');
    const keyOf = (name: string) => paneOrderKeys.find((p) => p.name === name)?.precedingPaneKey;
    expect(keyOf('ratio')).toBe('candle|volume');
    expect(keyOf('quote-totals')).toBe('candle|volume|ratio');
    // 아래 pane 2개 — 인덱스는 그대로지만 앞 시퀀스가 바뀐다.
    expect(keyOf('fill-strength')).toBe('candle|volume|ratio|quote-totals');
    expect(keyOf('program-trade')).toBe('candle|volume|ratio|quote-totals|fill-strength');
  });

  it('passes the venue-specific candle auction style context from props', () => {
    renderAt('1m', { venue: 'UN' });
    expect(paneContexts.find((pane) => pane.name === 'candle')?.contextOverride).toEqual({
      muteAuctionCandles: false,
    });
  });

  it('quoteTotalsEnabled=false → 총잔량 pane 미마운트', () => {
    useLivePageStore.setState({ quoteTotalsEnabled: false });
    renderAt('1m');
    expect(mounted).not.toContain('quote-totals');
    expect(mounted).toContain('ratio');
    expect(mounted).toContain('fill-strength');
    expect(mounted).toContain('program-trade');
  });

  it('ratio·fill 동시 off → candle·volume·총잔량·프로그램 순매수', () => {
    useLivePageStore.setState({ ratioEnabled: false, fillStrengthEnabled: false });
    renderAt('1m');
    expect(mounted).toEqual(['candle', 'volume', 'quote-totals', 'program-trade']);
  });

  it('volumeEnabled=false → 거래량 pane 미마운트', () => {
    useLivePageStore.setState({ volumeEnabled: false });
    renderAt('1m');
    expect(mounted).not.toContain('volume');
    expect(mounted[0]).toBe('candle');
  });

  it('peakWallPaneEnabled=true → peak-wall pane 이 quote-totals 뒤에 마운트 (opt-in)', () => {
    // 기본(미지정)은 위 「기본 6 pane」 테스트가 부재를 이미 잠근다 — 여기선 켠 경로만.
    useLivePageStore.setState({ peakWallPaneEnabled: true });
    renderAt('1m');
    expect(mounted).toEqual(['candle', 'volume', 'quote-totals', 'peak-wall', 'ratio', 'fill-strength', 'program-trade']);
  });

  it('calendar(D) → 호가 토글 무관, candle·volume만', () => {
    useLivePageStore.setState({ quoteTotalsEnabled: true, ratioEnabled: true, fillStrengthEnabled: true });
    renderAt('D');
    expect(mounted).toEqual(['candle', 'volume']);
  });

  it('uses the ambient timeframe bucket instead of flat legacy fields', () => {
    // 공개 세터 경로: minute 버킷에 기록 + ambient(1m) 투영 갱신.
    useLivePageStore.getState().setPanePrefForTimeframe('1m', 'ratioEnabled', false);
    renderAt('1m');
    expect(mounted).not.toContain('ratio');
    expect(mounted).toContain('quote-totals');
  });

  it('keeps /live D hoga panes gated even when the D bucket enables them', () => {
    useLivePageStore.getState().setPanePrefForTimeframe('D', 'quoteTotalsEnabled', true);
    useLivePageStore.getState().setPanePrefForTimeframe('D', 'ratioEnabled', true);
    useLivePageStore.getState().setPanePrefForTimeframe('D', 'fillStrengthEnabled', true);
    useLivePageStore.getState().setIndicatorTimeframe('D');
    renderAt('D');
    expect(mounted).toEqual(['candle', 'volume']);
  });

  it('allows forced study-style D hoga panes from the D bucket', () => {
    // 새 공장값은 호가 pane off — D 버킷에서 ratio·program-trade 만 켠 상태를 만든다.
    useLivePageStore.getState().setPanePrefForTimeframe('D', 'ratioEnabled', true);
    useLivePageStore.getState().setPanePrefForTimeframe('D', 'programTradeEnabled', true);
    useLivePageStore.getState().setPanePrefForTimeframe('D', 'quoteTotalsEnabled', false);
    useLivePageStore.getState().setPanePrefForTimeframe('D', 'fillStrengthEnabled', false);
    useLivePageStore.getState().setIndicatorTimeframe('D');
    renderAt('D', { forceHogaPanes: true });
    expect(mounted).toEqual(['candle', 'volume', 'ratio', 'program-trade']);
  });

  it('paneTogglesOverride가 live store 대신 저장된 indicator pane 상태를 적용한다', () => {
    useLivePageStore.setState({
      volumeEnabled: true,
      quoteTotalsEnabled: false,
      ratioEnabled: true,
      fillStrengthEnabled: false,
    });
    renderAt('1m', {
      paneTogglesOverride: {
        volumeEnabled: false,
        quoteTotalsEnabled: true,
        ratioEnabled: false,
        fillStrengthEnabled: true,
        programTradeEnabled: false,
      },
    });
    expect(mounted).toEqual(['candle', 'quote-totals', 'fill-strength']);
  });

  it('quote/ratio/fill panes receive the hoga-only bundle while program-trade stays on the full bundle', () => {
    const hogaPaneBundle = {
      ...DEFAULT_BUNDLE,
      quote_ratio: { bucket_ms: 60_000, points: [{ t: 1748275260000, ask_total: 10, bid_total: 20, ask_max: 10, bid_max: 20, imb_max_ask: 10, imb_max_bid: 20, band_pct: 0, tick: 0 }] },
    } satisfies RangeBundle;
    renderAt('1m', {
      bundle: DEFAULT_BUNDLE,
      hogaPaneBundle,
    });

    const byName = new Map(paneBundles.map((p) => [p.name, p.bundle]));
    expect(byName.get('quote-totals')).toBe(hogaPaneBundle);
    expect(byName.get('ratio')).toBe(hogaPaneBundle);
    expect(byName.get('fill-strength')).toBe(hogaPaneBundle);
    expect(byName.get('program-trade')).toBe(DEFAULT_BUNDLE);
  });

  // `chartBundle` 이 존재하는 **유일한 이유**가 이 성질이다 — SSE 틱이 캔들 경로의 props
  // 참조를 churn 하면 VirtualAxis·레이블 캐시가 무효화된다. 그런데 종전 테스트들은
  // "어느 번들이 어느 pane 에 도달하는가" 만 보고 **틱 후에도 같은 객체인지**는 묻지
  // 않았다. 그릇 배선을 옮기는 편집이 이 계약을 조용히 깨뜨릴 수 있어 값으로 못 박는다.
  //
  // 대조군(호가 pane)이 함께 있어야 한다 — 캔들만 보면 "애초에 아무것도 안 바뀌었다" 와
  // 구별되지 않는다.
  it('SSE 틱은 캔들 경로 pane 의 번들 참조를 바꾸지 않는다 (호가 pane 은 바뀐다)', () => {
    const chartBundle = {
      ...DEFAULT_BUNDLE,
      candles: [{ ts_ms: 1748275260000, open: 1, high: 2, low: 1, close: 2, vol_a: 10, vol_b: 0 }],
    } satisfies RangeBundle;
    const point = (askTotal: number) => ({
      bucket_ms: 60_000,
      points: [{ t: 1748275260000, ask_total: askTotal, bid_total: 20, ask_max: askTotal, bid_max: 20, imb_max_ask: askTotal, imb_max_bid: 20, band_pct: 0, tick: 0 }],
    });
    const beforeTick = { ...chartBundle, quote_ratio: point(10) } satisfies RangeBundle;
    const afterTick = { ...chartBundle, quote_ratio: point(11) } satisfies RangeBundle;

    const { rerender } = renderAt('1m', { bundle: beforeTick, chartBundle });
    const before = new Map(paneBundles.map((p) => [p.name, p.bundle]));
    paneBundles.length = 0;

    rerender(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        bundle={afterTick}
        chartBundle={chartBundle}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
    );
    const after = new Map(paneBundles.map((p) => [p.name, p.bundle]));

    expect(after.get('candle')).toBe(before.get('candle'));
    expect(after.get('quote-totals')).not.toBe(before.get('quote-totals'));
  });

  it('volume pane uses the stable chart bundle when volume cumulative is disabled', () => {
    const chartBundle = {
      ...DEFAULT_BUNDLE,
      candles: [{ ts_ms: 1748275260000, open: 1, high: 2, low: 1, close: 2, vol_a: 10, vol_b: 0 }],
    } satisfies RangeBundle;
    const liveBundle = {
      ...chartBundle,
      fill_strength: { bucket_ms: 60_000, points: [{ t: 1748275260000, buy_qty: 10, sell_qty: 2 }] },
    } satisfies RangeBundle;

    renderAt('1m', {
      bundle: liveBundle,
      chartBundle,
    });

    const byName = new Map(paneBundles.map((p) => [p.name, p.bundle]));
    expect(byName.get('volume')).toBe(chartBundle);
  });

  it('volume pane uses the live bundle only when volume cumulative is enabled', () => {
    useChartPrefsStore.getState().setToggle('volumeFillStrengthCumulative', true);
    const chartBundle = {
      ...DEFAULT_BUNDLE,
      candles: [{ ts_ms: 1748275260000, open: 1, high: 2, low: 1, close: 2, vol_a: 10, vol_b: 0 }],
    } satisfies RangeBundle;
    const liveBundle = {
      ...chartBundle,
      fill_strength: { bucket_ms: 60_000, points: [{ t: 1748275260000, buy_qty: 10, sell_qty: 2 }] },
    } satisfies RangeBundle;

    renderAt('1m', {
      bundle: liveBundle,
      chartBundle,
    });

    const byName = new Map(paneBundles.map((p) => [p.name, p.bundle]));
    expect(byName.get('volume')).toBe(liveBundle);
  });

  it('candle tooltip keeps the stable candle bundle but reads hoga values from the hoga bundle', () => {
    const chartBundle = {
      ...DEFAULT_BUNDLE,
      candles: [{ ts_ms: 1748275260000, open: 1, high: 2, low: 1, close: 2, vol_a: 10, vol_b: 0 }],
      quote_ratio: { bucket_ms: 60_000, points: [] },
    } satisfies RangeBundle;
    const hogaPaneBundle = {
      ...chartBundle,
      quote_ratio: { bucket_ms: 60_000, points: [{ t: 1748275260000, ask_total: 10, bid_total: 20, ask_max: 10, bid_max: 20, imb_max_ask: 10, imb_max_bid: 20, band_pct: 0, tick: 0 }] },
    } satisfies RangeBundle;

    renderAt('1m', {
      bundle: DEFAULT_BUNDLE,
      chartBundle,
      hogaPaneBundle,
    });

    expect(candleTooltipProps.at(-1)?.bundle).toBe(chartBundle);
    expect(candleTooltipProps.at(-1)?.quoteBundle).toBe(hogaPaneBundle);
  });

  it('viewIdentity 변경은 같은 code/timeframe에서도 chart identity를 교체한다', async () => {
    const { rerender } = render(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        viewIdentity="view-a"
        bundle={DEFAULT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
      { wrapper },
    );
    await waitFor(() => expect(chartInstances).toHaveLength(1));

    rerender(
      <LiveChartRoot
        code="005930"
        timeframe="1m"
        viewIdentity="view-b"
        bundle={DEFAULT_BUNDLE}
        clampEngaged={false}
        isPastCandlesLoading={false}
      />,
    );

    await waitFor(() => expect(chartInstances).toHaveLength(2));
    expect(chartInstances[0].remove).toHaveBeenCalled();
  });

  it('1m → 당일 매도 최대벽 오버레이 마운트', () => {
    renderAt('1m');
    expect(askPeakMounts).toEqual(['mounted']);
  });

  it.each(['D', 'W', 'M'] as const)('calendar(%s) → 당일 매도 최대벽 오버레이 미마운트', (timeframe) => {
    renderAt(timeframe);
    expect(askPeakMounts).toEqual([]);
  });

  it.each(['W', 'M'] as const)('calendar(%s) starts with candles plus right-side empty space', async (timeframe) => {
    renderAt(timeframe, { bundle: CALENDAR_BUNDLE });

    await waitFor(() => expect(chartInstances[0].timeScaleApi.setVisibleLogicalRange).toHaveBeenCalled());
    expect(chartInstances[0].timeScaleApi.fitContent).not.toHaveBeenCalled();
    expect(chartInstances[0].timeScaleApi.setVisibleLogicalRange).toHaveBeenCalledWith(expect.objectContaining({
      from: 0,
      to: expect.any(Number),
    }));
    const range = chartInstances[0].timeScaleApi.setVisibleLogicalRange.mock.calls.at(-1)?.[0];
    expect(range.to).toBeGreaterThan(CALENDAR_BUNDLE.candles.length);
  });

  it('1m mounts bid peak overlay, calendar does not', () => {
    renderAt('1m');
    expect(bidPeakMounts).toHaveLength(1);
    bidPeakMounts.length = 0;
    renderAt('D');
    expect(bidPeakMounts).toHaveLength(0);
  });

  it('mounts one shared peak-wall docked label overlay for minute charts', async () => {
    useLivePageStore.setState({ askPeakEnabled: true, bidPeakEnabled: true });
    renderAt('1m');

    await waitFor(() => {
      expect(askPeakMounts).toHaveLength(1);
      expect(bidPeakMounts).toHaveLength(1);
      expect(dockedLabelMounts).toHaveLength(1);
    });
  });
});

/**
 * **「보이는 최신 봉 기준」이 꺼져 있으면 시간범위를 구독하지 않는다**(2026-08-23).
 *
 * 이 구독의 콜백은 `setVisibleTimeCutoff` 로 **컴포넌트 전체를 재렌더**한다. 그런데 그 값은
 * 두 pref 가 다 꺼져 있으면 아래에서 통째로 버려진다 — 즉 기본 설정(둘 다 false)의
 * 사용자는 팬 프레임마다 아무 이득 없이 `LiveChartRoot` 재렌더 비용을 내고 있었다.
 *
 * **막는 방향**: 구독이 무조건으로 되돌아가는 것.
 * **못 보는 것**: 켜져 있을 때 컷오프가 실제로 갱신되는지 — 그건 pref ON 케이스가 본다.
 */
describe('LiveChartRoot — 보이는 최신 봉 컷오프 구독 게이트', () => {
  beforeEach(() => {
    chartInstances.length = 0;
    act(() => {
      useChartPrefsStore.setState({ ...DEFAULT_PREFS });
    });
  });

  const subscribeCalls = () => chartInstances
    .map((c) => c.timeScaleApi.subscribeVisibleTimeRangeChange.mock.calls.length)
    .reduce((a, b) => a + b, 0);

  it('두 pref 가 모두 꺼져 있으면 구독하지 않는다(기본값)', () => {
    renderAt('1m');
    expect(subscribeCalls()).toBe(0);
  });

  it('매도 pref 를 켜면 구독한다', () => {
    act(() => {
      useChartPrefsStore.setState({ askPeakVisibleTimeCutoff: true });
    });
    renderAt('1m');
    expect(subscribeCalls()).toBeGreaterThan(0);
  });

  it('매수 pref 만 켜도 구독한다', () => {
    act(() => {
      useChartPrefsStore.setState({ bidPeakVisibleTimeCutoff: true });
    });
    renderAt('1m');
    expect(subscribeCalls()).toBeGreaterThan(0);
  });
});
