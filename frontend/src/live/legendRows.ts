// Pane Legend — pure row model.
//
// `buildLegendRows` turns the MA store snapshot + the per-pane cursor-resolved
// cell values into the rows the `PaneLegendOverlay` renders, one per chart pane.
// Keeping it pure (values arrive as a Map / scalars, not a live chart) makes
// the gating rules unit-testable without a chart instance. The component owns
// the impure value extraction (`readSeriesValue` below) and feeds the result in.
//
// Row kinds:
//  - candle 'ma' / 'daily-ma': aggregates every enabled (daily-)MA slot (one
//    row, many swatches) and carries the shared hide flag. Special-cased
//    because MA has an eye toggle and a master on/off distinct from the
//    pane-mount lifecycle. 'daily-ma' additionally gates on the timeframe
//    (the overlay is minute-only — on D/W/M its series are cleared, so a row
//    would read all "—").
//  - 'flag': a name-only chip for overlay indicators that have no cursor value
//    (peak walls, POC band, depth heatmap — primitives/canvas, not value
//    series; broker late-entry markers on the ratio pane). Swatch(es) + label
//    + ✕; gated on the store enabled flag AND timeframe applicability,
//    mirroring each overlay's own mount gate. Emitted AFTER the cells rows so
//    a flag chip stacks below its pane's value row (ratio: 호가비 → 거래원).
//    Pane mount gating stays at render time (spec order lookup), same as
//    every other row.
//  - 'cells': a generic multi-cell row driven by `paneLegendRegistry`. Each cell
//    is one legend-bearing series (label + optional swatch + value). Registry
//    presence == pane mounted, so this path re-derives NO toggle state — the
//    mount gate (`paneSpecsForTimeframe`) stays the single source of "on?".
//    A cell whose value is null (series holds no data → toggle off / cold load)
//    is dropped; a pane left with no cells emits no row.

import type { ISeriesApi, SeriesType } from 'lightweight-charts';
import type { LiveMAConfig } from '../state/livePage';
import type { PaneId } from '../chart/drawing/types';
import type { PanePrefKey } from './indicators/indicatorPaneProfiles';
import { formatKoreanInt } from '../util/koreanNumber';

/** One moving-average slot's legend cell: swatch color + period + value. */
export type LegendMAValue = {
  id: string;
  color: string;
  period: number;
  value: number | null;
};

/** One rendered cell of a generic pane legend row: an optional swatch, a label,
 *  and the pre-formatted value string (null values are dropped upstream, so
 *  `formatted` is always a real string here). */
export type LegendCell = {
  key: string;
  color?: string;
  label: string;
  formatted: string;
};

/** Overlay indicators without a cursor value — legend shows a name chip
 *  (swatches + label + ✕) only. Ids double as the ✕ → store-setter dispatch
 *  key in `PaneLegendOverlay`. Most draw on the candle pane; broker late-entry
 *  markers attach to the ratio pane (RATIO_SPEC `labelMarkers`). */
export type LegendFlagId =
  | 'ask-peak'
  | 'bid-peak'
  | 'trade-volume-poc'
  | 'depth-heatmap'
  | 'depth-delta'
  | 'broker-late-entry';

/** One pre-formatted value cell of a flag row (values come from
 *  `flagLegendValueRegistry` providers — 지표별 포맷을 provider가 소유). */
export type LegendFlagCell = {
  key: string;
  label?: string;
  color?: string;
  value: string;
};

/** One flag indicator's input: `paneId` = the pane its overlay draws on,
 *  enabled = store toggle, applicable = "can this overlay draw on the current
 *  timeframe" (all five are minute-only, mirroring their mount gates).
 *  `hidden` = 눈 토글(그리기만 숨김 — 행과 값은 유지, MA 규칙 미러). */
export type LegendFlagInput = {
  id: LegendFlagId;
  paneId: PaneId;
  label: string;
  enabled: boolean;
  applicable: boolean;
  hidden: boolean;
  swatches: readonly string[];
  cells: readonly LegendFlagCell[];
};

/** OHLC readout for the candle pane's top row (always shown, no toggle). Prices
 *  + per-value change % vs the previous bar's close (null when there is no prior
 *  bar / prev.close ≤ 0). Resolved by the overlay from the hovered bar (cursor)
 *  or the latest bar (cursor away) via `buildCandleTooltip`. */
export type LegendOhlcValues = {
  open: number;
  high: number;
  low: number;
  close: number;
  openPct: number | null;
  highPct: number | null;
  lowPct: number | null;
  closePct: number | null;
};

/** A single pane's legend row. */
export type LegendRow =
  | ({ paneId: 'candle'; kind: 'ohlc' } & LegendOhlcValues)
  | { paneId: 'candle'; kind: 'ma'; mas: LegendMAValue[]; hidden: boolean }
  | { paneId: 'candle'; kind: 'daily-ma'; mas: LegendMAValue[]; hidden: boolean }
  | {
      paneId: PaneId;
      kind: 'flag';
      id: LegendFlagId;
      label: string;
      swatches: readonly string[];
      hidden: boolean;
      cells: readonly LegendFlagCell[];
    }
  | {
      paneId: PaneId;
      kind: 'cells';
      title?: string;
      cells: LegendCell[];
      /** Store toggle the ✕ turns off; absent → no ✕ (should not happen for the
       *  mounted panes, but keeps the render total). */
      toggleKey?: PanePrefKey;
    };

/** Impure input: one pane's cells with values already read from the chart. The
 *  overlay resolves `value`/`color` (chart + theme reads); this module formats
 *  and filters. `title`/`toggleKey` are static pane metadata (from the spec). */
export type PaneCellInput = {
  paneId: PaneId;
  title?: string;
  toggleKey?: PanePrefKey;
  cells: ReadonlyArray<{
    key: string;
    label: string;
    color?: string;
    value: number | null;
    format?: (v: number) => string;
  }>;
};

export type BuildLegendRowsInput = {
  /** Candle OHLC readout — emitted as the candle pane's FIRST (top) row when
   *  present. Unconditional (no store toggle): the "항상 표시" contract. Null when
   *  there are no drawn candles (cold load / empty view). */
  ohlc?: LegendOhlcValues | null;
  movingAverages: ReadonlyArray<LiveMAConfig>;
  /** MA master toggle. When off the overlay clears the series, so a row would
   *  read all-null on an invisible line — suppress it instead. */
  movingAverageEnabled: boolean;
  movingAverageHidden: boolean;
  /** slot id → value at cursor (or latest). Missing id → the cell shows "—". */
  maValues: ReadonlyMap<string, number>;
  /** Daily-MA mirror of the MA fields. `dailyMaApplicable` = minute timeframe
   *  (the overlay clears its series on D/W/M, so a row would read all "—").
   *  Optional so callers without a daily-MA context (tests) can omit them. */
  dailyMovingAverages?: ReadonlyArray<LiveMAConfig>;
  dailyMovingAverageEnabled?: boolean;
  dailyMovingAverageHidden?: boolean;
  dailyMaValues?: ReadonlyMap<string, number>;
  dailyMaApplicable?: boolean;
  /** Flag indicators (no cursor value) across panes. Rows emit for
   *  enabled && applicable entries, in input order, after the cells rows. */
  indicatorFlags?: ReadonlyArray<LegendFlagInput>;
  /** One entry per legend-bearing pane currently mounted (registry snapshot). */
  paneCells: ReadonlyArray<PaneCellInput>;
};

export function buildLegendRows(input: BuildLegendRowsInput): LegendRow[] {
  const rows: LegendRow[] = [];

  // Candle pane — OHLC readout, pinned as the top row and always shown (no
  // toggle). Pushed first so it stacks above the MA/daily-MA/flag rows.
  if (input.ohlc) {
    rows.push({ paneId: 'candle', kind: 'ohlc', ...input.ohlc });
  }

  // Candle pane — one row aggregating every enabled MA slot. Gated on the
  // master toggle (see field doc) so an invisible line never leaves an empty
  // "—" row behind.
  if (input.movingAverageEnabled) {
    const mas: LegendMAValue[] = input.movingAverages
      .filter((m) => m.enabled)
      .map((m) => ({
        id: m.id,
        color: m.color,
        period: m.period,
        value: input.maValues.get(m.id) ?? null,
      }));
    if (mas.length > 0) {
      rows.push({ paneId: 'candle', kind: 'ma', mas, hidden: input.movingAverageHidden });
    }
  }

  // Candle pane — daily-MA row, the MA row's mirror with an extra timeframe
  // gate (see field doc).
  if (input.dailyMovingAverageEnabled && input.dailyMaApplicable) {
    const mas: LegendMAValue[] = (input.dailyMovingAverages ?? [])
      .filter((m) => m.enabled)
      .map((m) => ({
        id: m.id,
        color: m.color,
        period: m.period,
        value: input.dailyMaValues?.get(m.id) ?? null,
      }));
    if (mas.length > 0) {
      rows.push({
        paneId: 'candle',
        kind: 'daily-ma',
        mas,
        hidden: input.dailyMovingAverageHidden ?? false,
      });
    }
  }

  // Generic pane rows. A null-valued cell means the series holds no data (its
  // toggle is off, or data hasn't loaded yet) — drop it; a pane with no
  // surviving cell emits no row. No per-pane toggle check: registry presence is
  // the gate.
  for (const pane of input.paneCells) {
    const cells: LegendCell[] = [];
    for (const c of pane.cells) {
      if (c.value === null) continue;
      cells.push({
        key: c.key,
        color: c.color,
        label: c.label,
        formatted: (c.format ?? formatKoreanInt)(c.value),
      });
    }
    if (cells.length > 0) {
      rows.push({
        paneId: pane.paneId,
        kind: 'cells',
        title: pane.title,
        cells,
        toggleKey: pane.toggleKey,
      });
    }
  }

  // Flag rows for valueless overlay indicators — after the cells rows so a
  // flag chip stacks below its pane's value row (candle rows are unaffected:
  // MA/daily-MA were pushed first and candle has no cells row).
  for (const flag of input.indicatorFlags ?? []) {
    if (!flag.enabled || !flag.applicable) continue;
    rows.push({
      paneId: flag.paneId,
      kind: 'flag',
      id: flag.id,
      label: flag.label,
      swatches: flag.swatches,
      hidden: flag.hidden,
      cells: flag.cells,
    });
  }

  return rows;
}

/**
 * 이 series 의 판독값. 우선순위 **셋**이고, OHLC 행의 봉 선택과 같은 순서다
 * (`PaneLegendOverlay` 의 OHLC 주석) — 한 레전드 안에서 행마다 다른 봉을 읽으면
 * 그것이야말로 "다른 차트" 로 읽힌다.
 *
 *   1. **내 마우스**가 올라간 점(`seriesData` = `param.seriesData`)
 *   2. **옆 창이 동기화로 그려 준 봉**(`atTimeSec` = 그 봉의 가상초)
 *   3. 최신 점(폴백)
 *
 * 2번이 따로 필요한 이유는 lwc 가 `setCrosshairPosition` 으로 그린 크로스헤어에
 * 대해 `subscribeCrosshairMove` 를 **발화시키지 않기** 때문이다(`CursorSyncCrosshair`
 * 헤더의 실측). 그래서 동기화 창은 `seriesData` 가 언제나 비어 있고, 3번만 있으면
 * **항상 최신 봉**을 읽는다 — 선은 과거 봉에 서 있는데 숫자만 오늘이 된다.
 *
 * 경계 하나: `atTimeSec` 은 **정확 일치**만 본다. 그 시각에 포인트가 없으면
 * (whitespace·결측) 3번으로 떨어지는데, 이는 **lwc 자체 크로스헤어와 같은 규칙**이다
 * — lwc 도 그 시각에 포인트가 없는 series 를 `param.seriesData` 에서 빼므로 1번이
 * 미스나 종전에도 최신으로 샜다. 둘을 갈라 놓으면 같은 결측이 호버할 때와 동기화될
 * 때 다른 값을 낸다. "—" 로 바꾸려면 **호버 경로도 같이** 바꿔야 한다.
 *
 * Pure over the chart API objects — pass a `{ data() }` stub to unit-test.
 */
export function readSeriesValue(
  series: ISeriesApi<SeriesType> | undefined,
  seriesData: ReadonlyMap<ISeriesApi<SeriesType>, unknown> | null,
  atTimeSec: number | null = null,
): number | null {
  if (!series) return null;
  if (seriesData) {
    const atCursor = pointValue(seriesData.get(series));
    if (atCursor !== null) return atCursor;
  }
  // `data()` is absent on a torn-down or stubbed series — degrade to null
  // ("—") rather than throwing inside a render frame.
  const dataFn = (series as { data?: () => readonly unknown[] }).data;
  if (typeof dataFn !== 'function') return null;
  const data = dataFn.call(series);
  if (!Array.isArray(data) || data.length === 0) return null;
  if (atTimeSec !== null) {
    const atSync = pointValue(findPointAtTime(data, atTimeSec));
    if (atSync !== null) return atSync;
  }
  return pointValue(data[data.length - 1]);
}

/** `timeSec` 에 **정확히** 서 있는 포인트(없으면 `undefined`).
 *
 *  series 데이터가 time 오름차순임에 기대는 이진 탐색이다 — lwc 가 그 순서를
 *  강제하므로(정렬되지 않은 `setData` 를 거부한다) 이 차트에 들어간 것은 이미
 *  정렬돼 있다.
 *
 *  `time` 이 숫자가 아니면(lwc 의 `BusinessDay` 객체) 비교할 수 없으므로 탐색을
 *  포기한다. 이 리포의 차트는 전부 가상초(number)라 도달 경로가 없지만, 억지로
 *  재서 엉뚱한 봉을 짚는 것보다 폴백이 낫다. */
function findPointAtTime(data: readonly unknown[], timeSec: number): unknown {
  let lo = 0;
  let hi = data.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = pointTime(data[mid]);
    if (t === null) return undefined;
    if (t === timeSec) return data[mid];
    if (t < timeSec) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

function pointTime(point: unknown): number | null {
  if (point && typeof point === 'object' && 'time' in point) {
    const t = (point as { time: unknown }).time;
    if (typeof t === 'number' && Number.isFinite(t)) return t;
  }
  return null;
}

function pointValue(point: unknown): number | null {
  if (point && typeof point === 'object' && 'value' in point) {
    const v = (point as { value: unknown }).value;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}
