import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import RangeSeriesPane, { type PaneSpec } from './RangeSeriesPane';

// RangeSeriesPane's only runtime (non-type) import besides syncSeriesData is the
// `SurgeMarkersPrimitive` class. Mock it so each instance records its setMarkers
// payloads into `markerSetCalls` for assertion (lightweight-charts imports are
// all type-only and erased, so no module mock is needed for it).
const { markerSetCalls } = vi.hoisted(() => ({ markerSetCalls: [] as unknown[][] }));
vi.mock('./SurgeMarkersPrimitive', () => ({
  SurgeMarkersPrimitive: class {
    setMarkers(m: unknown[]) { markerSetCalls.push(m); }
  },
}));
vi.mock('./BrokerLateEntryMarkersPrimitive', () => ({
  BrokerLateEntryMarkersPrimitive: class {
    setMarkers() {}
  },
}));

// Each addSeries returns a fresh stub so we can assert which series instance
// received setData after a re-create.
function makeChart() {
  const created: Array<{
    setData: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    paneIndex: number;
    attachPrimitive: ReturnType<typeof vi.fn>;
    detachPrimitive: ReturnType<typeof vi.fn>;
  }> = [];
  const addSeries = vi.fn((_type: unknown, _opts: unknown, paneIndex: number) => {
    const series = {
      setData: vi.fn(), update: vi.fn(), paneIndex,
      attachPrimitive: vi.fn(), detachPrimitive: vi.fn(),
    };
    created.push(series);
    return series;
  });
  const removeSeries = vi.fn();
  const chart = {
    addSeries,
    removeSeries,
  } as never;
  return { chart, created, addSeries, removeSeries };
}

const SPEC: PaneSpec = {
  name: 'volume',
  stretch: 0.3,
  series: [
    {
      type: {} as never,
      options: {} as never,
      data: () => [{ time: 1, value: 10 }] as never,
    },
  ],
};

// Stable refs so the data effect doesn't re-run for an unrelated reason.
const bundle = { candles: [] } as never;
const axis = { contains: () => true, toVirtual: (t: number) => t } as never;

// Projects candle rows so a test can vary the setData RESULT via the bundle.
// The production bug: a new bundle object carrying identical candles re-ran
// setData; the fix skips it by content signature.
type CandleBundle = { candles: Array<{ time: number; close: number }> };
const PROJECT_SPEC: PaneSpec = {
  name: 'candle',
  stretch: 1,
  series: [
    {
      type: {} as never,
      options: {} as never,
      data: (b) => (b as unknown as CandleBundle).candles.map((c) => ({ time: c.time, close: c.close })) as never,
    },
  ],
};
const candleBundle = (rows: Array<{ time: number; close: number }>) => ({ candles: rows }) as never;

describe('RangeSeriesPane', () => {
  afterEach(cleanup);

  it('re-pushes data after a paneIndex change re-creates the series', () => {
    // Regression: removing a pane above (volume off) shifts this pane's index,
    // which re-creates the series. The data effect must re-run too, or the new
    // series renders empty until a full remount (investor bars vanished bug).
    const { chart, created } = makeChart();
    const { rerender } = render(
      <RangeSeriesPane chart={chart} bundle={bundle} axis={axis} paneIndex={2} precedingPaneKey="" spec={SPEC} />,
    );
    expect(created).toHaveLength(1);
    expect(created[0].setData).toHaveBeenCalledTimes(1); // initial push

    // Pane above removed → this pane shifts 2 → 1 → lifecycle re-creates series.
    rerender(
      <RangeSeriesPane chart={chart} bundle={bundle} axis={axis} paneIndex={1} precedingPaneKey="" spec={SPEC} />,
    );
    expect(created).toHaveLength(2);
    expect(created[1].paneIndex).toBe(1);
    expect(created[1].setData).toHaveBeenCalledTimes(1); // data re-pushed into the new series
  });

  it('creates the candle primary series last when candleAlwaysOnTop is enabled', () => {
    const { chart, created, addSeries } = makeChart();
    const primaryType = { name: 'candles' } as never;
    const overlayType = { name: 'overlay' } as never;
    const candlePaneSpec: PaneSpec = {
      name: 'candle',
      stretch: 1,
      series: [
        {
          type: primaryType,
          options: {} as never,
          data: () => [{ time: 1, open: 10, high: 12, low: 9, close: 11 }] as never,
        },
        {
          type: overlayType,
          options: {} as never,
          data: () => [{ time: 1, value: 11 }] as never,
        },
      ],
    };
    const onPrimarySeriesReady = vi.fn();

    render(
      <RangeSeriesPane
        chart={chart}
        bundle={bundle}
        axis={axis}
        paneIndex={0} precedingPaneKey=""
        spec={candlePaneSpec}
        candleAlwaysOnTop
        onPrimarySeriesReady={onPrimarySeriesReady}
      />,
    );

    expect(addSeries).toHaveBeenNthCalledWith(1, overlayType, {}, 0);
    expect(addSeries).toHaveBeenNthCalledWith(2, primaryType, {}, 0);
    expect(created[0].setData).toHaveBeenCalledWith([{ time: 1, value: 11 }]);
    expect(created[1].setData).toHaveBeenCalledWith([{ time: 1, open: 10, high: 12, low: 9, close: 11 }]);
    expect(onPrimarySeriesReady).toHaveBeenCalledWith(created[1], 'candle');
  });

  it('uses contextOverride instead of the spec context value', () => {
    const { chart, created } = makeChart();
    const data = vi.fn((_bundle, _axis, ctx: { value: string }) => [{ time: 1, value: ctx.value.length }]);
    const useContext = vi.fn(() => ({ value: 'hook' }));
    const spec: PaneSpec<{ value: string }> = {
      name: 'volume',
      stretch: 1,
      useContext,
      series: [{ type: {} as never, options: {} as never, data: data as never }],
    };

    render(
      <RangeSeriesPane
        chart={chart}
        bundle={bundle}
        axis={axis}
        paneIndex={0} precedingPaneKey=""
        spec={spec}
        contextOverride={{ value: 'override' }}
      />,
    );

    expect(useContext).toHaveBeenCalledOnce();
    expect(data).toHaveBeenCalledWith(bundle, axis, { value: 'override' });
    expect(created[0].setData).toHaveBeenCalledWith([{ time: 1, value: 8 }]);
  });

  it('re-pushes data after a chart change re-creates the series (per-view remount)', () => {
    // Regression: /live remounts the lwc chart per (code, timeframe) view
    // (LiveChartRoot's per-viewKey effect). The lifecycle effect re-creates
    // the series on the new chart instance; the data effect must re-run in
    // the same commit (chart is in its deps) or the pane renders blank until
    // the next bundle identity change (up to a 60s refetch on D/W/M).
    const first = makeChart();
    const { rerender } = render(
      <RangeSeriesPane chart={first.chart} bundle={bundle} axis={axis} paneIndex={1} precedingPaneKey="" spec={SPEC} />,
    );
    expect(first.created).toHaveLength(1);

    const second = makeChart();
    rerender(
      <RangeSeriesPane chart={second.chart} bundle={bundle} axis={axis} paneIndex={1} precedingPaneKey="" spec={SPEC} />,
    );
    expect(second.created).toHaveLength(1);
    expect(second.created[0].setData).toHaveBeenCalledTimes(1); // data re-pushed into the new chart's series
  });

  it('does NOT re-create the series when only bundle data changes', () => {
    // The MA-edit optimization: data churn must not churn series handles.
    const { chart, created } = makeChart();
    const { rerender } = render(
      <RangeSeriesPane chart={chart} bundle={bundle} axis={axis} paneIndex={1} precedingPaneKey="" spec={SPEC} />,
    );
    expect(created).toHaveLength(1);
    rerender(
      <RangeSeriesPane chart={chart} bundle={{ candles: [] } as never} axis={axis} paneIndex={1} precedingPaneKey="" spec={SPEC} />,
    );
    // New bundle ref → data effect re-runs, but series NOT re-created.
    expect(created).toHaveLength(1);
  });

  it('SKIPS a redundant setData when the projected data is unchanged', () => {
    // /live remounts + re-renders ~24× during a timeframe switch, handing down a
    // fresh `bundle` object each time while `bundle.candles` stays identical.
    // lwc re-runs price autoscale + viewport settle on EVERY setData, so those
    // identical re-pushes visibly re-fit the chart after the reveal cover lifts.
    // The data effect must skip a push whose result matches the last one.
    const { chart, created } = makeChart();
    const rows = [{ time: 1, close: 100 }, { time: 2, close: 110 }];
    const { rerender } = render(
      <RangeSeriesPane chart={chart} bundle={candleBundle(rows)} axis={axis} paneIndex={1} precedingPaneKey="" spec={PROJECT_SPEC} />,
    );
    expect(created[0].setData).toHaveBeenCalledTimes(1); // initial push
    // New bundle OBJECT, identical candle CONTENT → setData must be skipped.
    rerender(
      <RangeSeriesPane chart={chart} bundle={candleBundle([...rows])} axis={axis} paneIndex={1} precedingPaneKey="" spec={PROJECT_SPEC} />,
    );
    expect(created).toHaveLength(1); // series not re-created
    expect(created[0].setData).toHaveBeenCalledTimes(1); // redundant push SKIPPED
  });

  it('uses update(tail) when only the last bar changes / one bar appends — not over-skipping', () => {
    // A live tick mutates the last bar (same time, new close) or appends one new
    // bar. The change MUST flow through — over-aggressive skipping would freeze
    // the chart mid-session — but as series.update(tail), not a full setData, so
    // lwc doesn't re-ingest + re-autoscale the whole array every 150ms tick.
    const { chart, created } = makeChart();
    const { rerender } = render(
      <RangeSeriesPane chart={chart} bundle={candleBundle([{ time: 1, close: 100 }, { time: 2, close: 110 }])} axis={axis} paneIndex={1} precedingPaneKey="" spec={PROJECT_SPEC} />,
    );
    expect(created[0].setData).toHaveBeenCalledTimes(1); // initial full push
    expect(created[0].update).toHaveBeenCalledTimes(0);
    // Last bar's close changed → update(last), NOT setData.
    rerender(
      <RangeSeriesPane chart={chart} bundle={candleBundle([{ time: 1, close: 100 }, { time: 2, close: 112 }])} axis={axis} paneIndex={1} precedingPaneKey="" spec={PROJECT_SPEC} />,
    );
    expect(created[0].setData).toHaveBeenCalledTimes(1); // no full re-push
    expect(created[0].update).toHaveBeenCalledTimes(1);
    expect(created[0].update).toHaveBeenLastCalledWith({ time: 2, close: 112 });
    // A new bar appended (length +1, prefix identical) → update(appended).
    rerender(
      <RangeSeriesPane chart={chart} bundle={candleBundle([{ time: 1, close: 100 }, { time: 2, close: 112 }, { time: 3, close: 108 }])} axis={axis} paneIndex={1} precedingPaneKey="" spec={PROJECT_SPEC} />,
    );
    expect(created[0].setData).toHaveBeenCalledTimes(1);
    expect(created[0].update).toHaveBeenCalledTimes(2);
    expect(created[0].update).toHaveBeenLastCalledWith({ time: 3, close: 108 });
  });

  it('forceSetData skips identical data but fully replaces when data changes', () => {
    // Calendar candlesticks use forceSetData to avoid stale lwc candlestick
    // geometry on real OHLC changes. It must not turn unrelated parent
    // re-renders (same projected data) into another full setData, because lwc
    // re-settles the viewport after setData and creates a visible refit.
    const { chart, created } = makeChart();
    const rows = [{ time: 1, close: 100 }, { time: 2, close: 110 }];
    const { rerender } = render(
      <RangeSeriesPane chart={chart} bundle={candleBundle(rows)} axis={axis} paneIndex={1} precedingPaneKey="" spec={PROJECT_SPEC} forceSetData />,
    );
    expect(created[0].setData).toHaveBeenCalledTimes(1);

    rerender(
      <RangeSeriesPane chart={chart} bundle={candleBundle([...rows])} axis={axis} paneIndex={1} precedingPaneKey="" spec={PROJECT_SPEC} forceSetData />,
    );
    expect(created[0].setData).toHaveBeenCalledTimes(1);
    expect(created[0].update).not.toHaveBeenCalled();

    rerender(
      <RangeSeriesPane chart={chart} bundle={candleBundle([{ time: 1, close: 100 }, { time: 2, close: 112 }])} axis={axis} paneIndex={1} precedingPaneKey="" spec={PROJECT_SPEC} forceSetData />,
    );
    expect(created[0].update).not.toHaveBeenCalled();
    expect(created[0].setData).toHaveBeenCalledTimes(2);
  });

  it('falls back to setData when an earlier bar changes (auction-mask retroactive recolor pattern)', () => {
    // classifyDataChange must NOT update(tail) when a non-tail element changed —
    // that is the maskOutgoingConnector / cumulative-rewrite case where the whole
    // array must be re-pushed. Earlier-element change → full setData.
    const { chart, created } = makeChart();
    const { rerender } = render(
      <RangeSeriesPane chart={chart} bundle={candleBundle([{ time: 1, close: 100 }, { time: 2, close: 110 }])} axis={axis} paneIndex={1} precedingPaneKey="" spec={PROJECT_SPEC} />,
    );
    expect(created[0].setData).toHaveBeenCalledTimes(1);
    // First (non-tail) bar changed → setData fallback, not update.
    rerender(
      <RangeSeriesPane chart={chart} bundle={candleBundle([{ time: 1, close: 999 }, { time: 2, close: 110 }])} axis={axis} paneIndex={1} precedingPaneKey="" spec={PROJECT_SPEC} />,
    );
    expect(created[0].setData).toHaveBeenCalledTimes(2); // full re-push
    expect(created[0].update).toHaveBeenCalledTimes(0);
  });

  it('markers 프로젝터가 있으면 SurgeMarkersPrimitive.setMarkers로 마커를 갱신한다', () => {
    markerSetCalls.length = 0;
    const { chart, created } = makeChart();
    const markerSpec: PaneSpec = {
      name: 'with-markers',
      stretch: 1,
      series: [
        {
          type: {} as never,
          options: {} as never,
          data: () => [{ time: 1, value: 10 }] as never,
          markers: () => [{ time: 1, price: 10, color: '#fff' }] as never,
        },
      ],
    };
    render(
      <RangeSeriesPane chart={chart} bundle={bundle} axis={axis} paneIndex={0} precedingPaneKey="" spec={markerSpec} />,
    );
    // primitive가 series에 attach되고, 마커 페이로드(time·price·color)가 전달된다.
    expect(created[0].attachPrimitive).toHaveBeenCalledTimes(1);
    expect(markerSetCalls.at(-1)).toEqual([{ time: 1, price: 10, color: '#fff' }]);
  });

  it('legend 메타 series만 zip해 onLegendReady로 넘기고 unmount에서 onLegendGone을 발화한다', () => {
    // Pane Legend 배선의 급소: RangeSeriesPane이 legend 메타를 가진 series들만
    // (spec 순서대로) 생성된 핸들과 zip해 콜백으로 넘겨야 registry → overlay가
    // 올바른 series에서 값을 읽는다. 메타 없는 series(0-baseline 가이드 등)는 제외.
    const { chart, created } = makeChart();
    const buyLegend = { label: '매수', color: () => '#F04452' };
    const cumLegend = { label: '누적' };
    const legendSpec: PaneSpec = {
      name: 'fill-strength',
      stretch: 1,
      legendToggleKey: 'fillStrengthEnabled',
      series: [
        { type: {} as never, options: {} as never, data: () => [] as never, legend: buyLegend },
        { type: {} as never, options: {} as never, data: () => [] as never }, // legend-silent
        { type: {} as never, options: {} as never, data: () => [] as never, legend: cumLegend },
      ],
    };
    const onLegendReady = vi.fn();
    const onLegendGone = vi.fn();
    const { unmount } = render(
      <RangeSeriesPane
        chart={chart}
        bundle={bundle}
        axis={axis}
        paneIndex={0} precedingPaneKey=""
        spec={legendSpec}
        onLegendReady={onLegendReady}
        onLegendGone={onLegendGone}
      />,
    );

    expect(onLegendReady).toHaveBeenCalledTimes(1);
    expect(onLegendReady).toHaveBeenCalledWith('fill-strength', [
      { series: created[0], meta: buyLegend },
      { series: created[2], meta: cumLegend },
    ]);
    expect(onLegendGone).not.toHaveBeenCalled();

    unmount();
    expect(onLegendGone).toHaveBeenCalledTimes(1);
    expect(onLegendGone).toHaveBeenCalledWith('fill-strength');
  });

  it('legend 메타가 하나도 없는 spec은 onLegendReady/Gone을 발화하지 않는다', () => {
    const { chart } = makeChart();
    const onLegendReady = vi.fn();
    const onLegendGone = vi.fn();
    const { unmount } = render(
      <RangeSeriesPane
        chart={chart}
        bundle={bundle}
        axis={axis}
        paneIndex={0} precedingPaneKey=""
        spec={SPEC}
        onLegendReady={onLegendReady}
        onLegendGone={onLegendGone}
      />,
    );
    unmount();
    expect(onLegendReady).not.toHaveBeenCalled();
    expect(onLegendGone).not.toHaveBeenCalled();
  });

  it('labelMarkers 프로젝터가 있으면 label primitive를 attach하고 unmount에서 detach한다', () => {
    const { chart, created } = makeChart();
    const labelMarkerSpec = {
      name: 'with-label-markers',
      stretch: 1,
      series: [
        {
          type: {} as never,
          options: {} as never,
          data: () => [{ time: 1, value: 10 }] as never,
          labelMarkers: () => [{
            time: 1,
            anchorTime: 1,
            price: 10,
            broker: '삼성증권',
            label: '삼성',
            side: 'buy',
            color: '#ef4444',
          }] as never,
        },
      ],
    } as PaneSpec;
    const { unmount } = render(
      <RangeSeriesPane chart={chart} bundle={bundle} axis={axis} paneIndex={0} precedingPaneKey="" spec={labelMarkerSpec} />,
    );

    expect(created[0].attachPrimitive).toHaveBeenCalledTimes(1);

    unmount();
    expect(created[0].detachPrimitive).toHaveBeenCalledTimes(1);
  });
});

// ── pane 순서 바꾸기: 재생성 중 인덱스 시프트 ─────────────────────────────────
//
// 이 파일의 다른 차트 스텁(`makeChart`)은 `removeSeries` 가 no-op 이고 pane 을 아예
// 모형화하지 않아서 **이 버그를 원리적으로 못 본다**. 여기서는 lwc 5.2.0 의 실측
// 동작을 그대로 재현한다 — pane 의 마지막 series 를 지우면 그 pane 이 사라지고
// 아래 pane 들의 인덱스가 당겨진다.
function makePaneChart() {
  const panes: unknown[][] = [];
  /** `addSeries` 가 현재 pane 수보다 **2 이상 큰** 인덱스를 요구한 횟수. 정상 경로는
   *  오름차순 append 뿐이라 항상 0 이어야 한다(0 이 아니면 중간에 빈 pane 이 생긴다). */
  const gapRequests: number[] = [];
  const chart = {
    addSeries: vi.fn((_type: unknown, _opts: unknown, paneIndex: number) => {
      const series = {
        setData: vi.fn(), update: vi.fn(),
        attachPrimitive: vi.fn(), detachPrimitive: vi.fn(),
      };
      if (paneIndex > panes.length) gapRequests.push(paneIndex);
      while (panes.length <= paneIndex) panes.push([]);
      panes[paneIndex].push(series);
      return series;
    }),
    removeSeries: vi.fn((series: unknown) => {
      const i = panes.findIndex((p) => p.includes(series));
      if (i < 0) return;
      panes[i] = panes[i].filter((x) => x !== series);
      if (panes[i].length === 0) panes.splice(i, 1);
    }),
  } as never;
  return { chart, panes, gapRequests };
}

/** series 개수가 서로 다른 pane 스펙 — pane 별 개수만 보고 어느 스펙이 어디 있는지
 *  식별할 수 있다(합쳐지면 개수가 더해지므로 병합도 그대로 드러난다). */
function specWithSeriesCount(name: string, count: number): PaneSpec {
  return {
    name,
    stretch: 1,
    series: Array.from({ length: count }, () => ({
      type: {} as never,
      options: {} as never,
      data: () => [{ time: 1, value: 1 }] as never,
    })),
  };
}
const REORDER_SPECS: Record<string, PaneSpec> = {
  a: specWithSeriesCount('a', 3),
  b: specWithSeriesCount('b', 2),
  c: specWithSeriesCount('c', 1),
  d: specWithSeriesCount('d', 4),
};

/** LiveChartRoot 의 `visiblePaneSpecs.map` 을 그대로 흉내낸다 — key 는 pane 이름,
 *  `precedingPaneKey` 는 앞 pane 이름 시퀀스. */
function PaneStack({ chart, names }: { chart: never; names: string[] }) {
  let acc = '';
  return (
    <>
      {names.map((n, i) => {
        const preceding = acc;
        acc = acc === '' ? n : `${acc}|${n}`;
        return (
          <RangeSeriesPane
            key={n}
            chart={chart}
            bundle={bundle}
            axis={axis}
            paneIndex={i}
            precedingPaneKey={preceding}
            spec={REORDER_SPECS[n]}
          />
        );
      })}
    </>
  );
}

describe('RangeSeriesPane — pane 순서 바꾸기 (인덱스 시프트)', () => {
  afterEach(cleanup);

  it('가운데 두 pane 을 맞바꿔도 아래 pane 이 살아남고 pane 구성이 순열만 바뀐다', () => {
    const { chart, panes, gapRequests } = makePaneChart();
    const { rerender } = render(<PaneStack chart={chart} names={['a', 'b', 'c', 'd']} />);
    expect(panes.map((p) => p.length)).toEqual([3, 2, 1, 4]);

    rerender(<PaneStack chart={chart} names={['a', 'c', 'b', 'd']} />);

    // 버그가 있으면 b·c 만 재생성되고 d 는 참여하지 않는다 → cleanup 이 pane 1·2 를
    // 지우면서 d 가 인덱스 1 로 밀리고, 뒤이은 addSeries 가 d 의 pane 안으로 합쳐진다
    // (실측 서명: pane 4개 → 3개, 개수 [3, 5, 2]).
    expect(panes).toHaveLength(4);
    expect(panes.map((p) => p.length)).toEqual([3, 1, 2, 4]);
    // 재구성은 오름차순 append 여야 한다 — 중간에 빈 pane 이 생기면 안 된다.
    expect(gapRequests).toEqual([]);
  });

  it('맨 앞 두 pane 을 맞바꿔도 아래 두 pane 이 그대로 남는다', () => {
    const { chart, panes, gapRequests } = makePaneChart();
    const { rerender } = render(<PaneStack chart={chart} names={['a', 'b', 'c', 'd']} />);

    rerender(<PaneStack chart={chart} names={['b', 'a', 'c', 'd']} />);

    expect(panes).toHaveLength(4);
    expect(panes.map((p) => p.length)).toEqual([2, 3, 1, 4]);
    expect(gapRequests).toEqual([]);
  });

  it('순서가 그대로면 재생성하지 않는다 (앞 시퀀스 불변)', () => {
    const { chart, panes } = makePaneChart();
    const { rerender } = render(<PaneStack chart={chart} names={['a', 'b', 'c', 'd']} />);
    const firstSeriesOfD = panes[3][0];

    rerender(<PaneStack chart={chart} names={['a', 'b', 'c', 'd']} />);

    // 같은 핸들이 유지돼야 한다 — 순서 dep 이 과민하면 매 렌더 series 가 churn 한다.
    expect(panes[3][0]).toBe(firstSeriesOfD);
  });

  it('맨 뒤에 pane 을 추가해도 기존 pane 들은 재생성되지 않는다', () => {
    const { chart, panes } = makePaneChart();
    const { rerender } = render(<PaneStack chart={chart} names={['a', 'b', 'c']} />);
    const firstSeriesOfC = panes[2][0];

    rerender(<PaneStack chart={chart} names={['a', 'b', 'c', 'd']} />);

    expect(panes.map((p) => p.length)).toEqual([3, 2, 1, 4]);
    expect(panes[2][0]).toBe(firstSeriesOfC);
  });
});
