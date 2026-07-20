// Pane Legend — a TradingView-style legend pinned to each chart pane's
// top-left: indicator label + color swatch + the value under the cursor
// (latest point when the cursor is away), with ✕ (turn the indicator off) and
// (MA only) an eye (hide the MA lines) control.
//
// Value source is the SAME series the chart draws — read back through
// `param.seriesData` (cursor) / `series.data()` (latest), never recomputed.
// MA slot series come from `maSeriesRegistry`; every other pane's legend series
// come from `paneLegendRegistry` (populated by RangeSeriesPane for any pane
// whose spec declares `legend` metadata). Registry presence == pane mounted, so
// the generic rows re-derive NO toggle state. Pane-level ✕ target + title are
// read from the pane spec (`paneSpecsForTimeframe`), which is also the runtime
// pane order used for Y placement — summed over `chart.panes()[i].getHeight()`,
// NOT `chartCoordinates.paneTopY` (static PANE_SPECS returns 0 for the
// runtime-appended investor panes).
//
// See docs/superpowers/specs/2026-05-31-chart-indicator-legend-design.md.

import { memo, useEffect, useReducer, useRef, type CSSProperties } from 'react';
import type { IChartApi, MouseEventParams } from 'lightweight-charts';
import { isMinuteTimeframe, type LiveTimeframe } from '../state/livePage';
import {
  useIndicatorActions,
  useWindowIndicator,
  useWindowPaneOrder,
  useWindowScopeId,
  type IndicatorActions,
} from './workspace/windowView';
import { useMaSeriesRegistry } from './indicators/maSeriesRegistry';
import { useDailyMaSeriesRegistry } from './indicators/dailyMaSeriesRegistry';
import { usePaneLegendRegistry } from './indicators/paneLegendRegistry';
import { paneSpecsForTimeframe, type PaneToggles } from './paneSpecsForTimeframe';
import type { PaneId } from '../chart/drawing/types';
import { movePaneBeside } from '../chart/paneOrder';
import {
  buildLegendRows,
  readSeriesValue,
  type LegendFlagId,
  type LegendFlagInput,
  type LegendRow,
  type PaneCellInput,
} from './legendRows';
import { readFlagLegendValues } from './indicators/flagLegendValueRegistry';
import { formatKoreanInt } from '../util/koreanNumber';

type Props = {
  chart: IChartApi;
  timeframe: LiveTimeframe;
  paneToggles: PaneToggles;
  /** 단별 잔량 증감 데이터 유무. 이 지표는 오늘 SSE 에서만 나오므로 /study 나 과거일
   *  전용 뷰에서는 켜져 있어도 그릴 것이 없다 — 그때 값 없는 빈 레전드 행이 남지 않도록
   *  `applicable` 을 데이터 유무까지 좁힌다(오버레이 마운트 게이트와 일치시키는 규약). */
  hasDepthDelta?: boolean;
  /** P1: latest-값 신선화 토큰(캔들 경로 chartBundle ref). /live가 SSE 호가 틱마다
   *  부모(LiveChartRoot)를 재렌더하지만 memo + 이 prop이 그 재렌더를 차단하고, 캔들
   *  갱신(chartBundle 식별자 변경) 때만 latest 값을 신선화한다. 본문에서 읽지 않고
   *  memo 얕은 비교 신호로만 쓴다.
   *
   *  의도된 트레이드오프 — 호가-경로 pane(총잔량·호가비·체결강도·프로그램, 누적 ON
   *  volume)은 SSE로 초 단위 데이터가 흐르지만, 커서 idle 시 레전드 latest는 이 epoch
   *  주기(≈캔들 1개)로만 갱신된다. 정확한 지금-값은 크로스헤어로 읽는 것이 제품 규칙
   *  (ratio.ts `lastValueVisible:false` "latest via crosshair" 선례; idle 실시간은
   *  PR #503 현재값 수평선 토글이 담당). 호버 중엔 크로스헤어 구독이 실시간 갱신하므로
   *  이 staleness는 idle readout에만 해당. 호가 bundle을 epoch로 넣으면 P1이 제거한
   *  SSE 틱당 O(N) series.data() 리드백이 부활하므로 금지 — idle 실시간이 필요해지면
   *  epoch 재렌더가 아니라 원시값 타겟 구독(LiveCurrentPriceLine 패턴)으로 구현할 것. */
  dataEpoch?: unknown;
};

// Worst-case width `-9,999,999` (~11 glyphs) reserved so the value cell never
// reflows as the cursor sweeps across magnitudes (DESIGN.md tabular-nums).
const VALUE_MIN_WIDTH = '12ch';
const LEGEND_INSET = 'var(--space-xs)';

// Positioned by the per-pane stack wrapper (flex column), not absolutely —
// a pane can now hold several rows (candle: MA + daily-MA + flag chips).
const boxStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--space-xs)',
  // Opaque surface — translucent has no DESIGN.md token, and a legend over
  // saturated candles needs guaranteed contrast (SourceChip precedent). 불투명
  // bg-card 채움이 캔들 위 가독성을 담당하므로, 외곽선(border) 없이도 텍스트는 읽힌다
  // (2026-07-15 borderless). 차트 배경=bg-card라 빈 영역에선 자연스럽게 녹아든다.
  background: 'var(--bg-card)',
  borderRadius: 'var(--radius-md)',
  padding: 'var(--space-2xs) var(--space-sm)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--text-xs)',
  lineHeight: 1.4,
  whiteSpace: 'nowrap',
  // Multi-cell panes (체결강도 3셀) can outgrow a narrow chart — clip rather
  // than push the page. The crosshair is pointerEvents:none under the legend,
  // so a clipped legend loses no function.
  maxWidth: '100%',
  overflow: 'hidden',
};

const iconBtnStyle: CSSProperties = {
  // The container is pointer-events:none so the crosshair still tracks under
  // the legend (this feature's whole point). Re-enable hits on the controls.
  pointerEvents: 'auto',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 18,
  height: 18,
  padding: 0,
  border: 'none',
  background: 'none',
  cursor: 'pointer',
  color: 'var(--fg-dimmer)',
  transition: 'color 80ms ease-in-out',
};

const valueCellStyle: CSSProperties = {
  minWidth: VALUE_MIN_WIDTH,
  textAlign: 'right',
  color: 'var(--fg)',
  fontVariantNumeric: 'tabular-nums',
};

const swatchStyle: CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: 'var(--radius-sm)',
  display: 'inline-block',
};

function HoverIcon({
  label,
  restColor,
  onClick,
  children,
}: {
  label: string;
  restColor: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      style={{ ...iconBtnStyle, color: restColor }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = 'var(--fg-dim)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = restColor;
      }}
    >
      {children}
    </button>
  );
}

function ChevronGlyph({ dir }: { dir: 'up' | 'down' }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path
        d={dir === 'up' ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** pane 순서 이동 버튼 하나(↑ 또는 ↓). disabled 시 클릭 불가·저채도. HoverIcon 은
 *  disabled/testId 를 안 받으므로 별도 — iconBtnStyle 재사용. */
function PaneMoveButton({
  dir,
  label,
  testId,
  disabled,
  onClick,
}: {
  dir: 'up' | 'down';
  label: string;
  testId: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      style={{
        ...iconBtnStyle,
        width: 16,
        height: 16,
        cursor: disabled ? 'default' : 'pointer',
        color: disabled ? 'var(--fg-disabled, var(--fg-dimmer))' : 'var(--fg-dimmer)',
        opacity: disabled ? 0.4 : 1,
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.color = 'var(--fg-dim)';
      }}
      onMouseLeave={(e) => {
        if (!disabled) e.currentTarget.style.color = 'var(--fg-dimmer)';
      }}
    >
      <ChevronGlyph dir={dir} />
    </button>
  );
}

/** 한 pane 의 ↑/↓ 순서 이동 컨트롤. candle(idx 0)은 렌더하지 않는다. 이동은
 *  **마운트된 이웃과 스왑**이라 게이트로 부재중인 pane 을 건너뛴다(ADR-0114 §3). */
function PaneMoveControls({
  paneId,
  label,
  idx,
  mountedCount,
  upNeighbor,
  downNeighbor,
  paneOrder,
}: {
  paneId: PaneId;
  label: string;
  idx: number;
  mountedCount: number;
  /** 바로 위/아래에 **마운트된** 이웃 pane(게이트로 부재중인 pane 은 건너뛴 값). */
  upNeighbor: PaneId | null;
  downNeighbor: PaneId | null;
  paneOrder: readonly PaneId[];
}) {
  const setPaneOrder = useIndicatorActions().setPaneOrder;
  // idx 1 의 위 이웃은 candle(고정) → 위로 이동 불가. 마지막 마운트 pane → 아래 불가.
  const canUp = idx > 1 && upNeighbor !== null && upNeighbor !== 'candle';
  const canDown = idx < mountedCount - 1 && downNeighbor !== null;
  return (
    <span style={{ ...boxStyle, gap: 'var(--space-2xs)', pointerEvents: 'auto', padding: 'var(--space-2xs)' }}>
      <PaneMoveButton
        dir="up"
        label={`${label} pane 위로 이동`}
        testId={`pane-move-up-${paneId}`}
        disabled={!canUp}
        onClick={() => { if (canUp && upNeighbor) setPaneOrder(movePaneBeside(paneOrder, paneId, upNeighbor, 'before')); }}
      />
      <PaneMoveButton
        dir="down"
        label={`${label} pane 아래로 이동`}
        testId={`pane-move-down-${paneId}`}
        disabled={!canDown}
        onClick={() => { if (canDown && downNeighbor) setPaneOrder(movePaneBeside(paneOrder, paneId, downNeighbor, 'after')); }}
      />
    </span>
  );
}

function CloseGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function EyeGlyph({ hidden }: { hidden: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <path
        d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
      {hidden && (
        // Struck-through eye = MA lines hidden (distinct from ✕ = off).
        <path d="M4 4l16 16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      )}
    </svg>
  );
}

/** ✕ dispatch for flag rows — id → master toggle off. 창-스코프 절단으로
 *  actions 를 인자로 받는다(컴포넌트가 useIndicatorActions 로 공급). */
const FLAG_TURN_OFF: Record<LegendFlagId, (a: IndicatorActions) => void> = {
  'ask-peak': (a) => a.setAskPeakEnabled(false),
  'bid-peak': (a) => a.setBidPeakEnabled(false),
  'trade-volume-poc': (a) => a.setTradeVolumePocEnabled(false),
  'depth-heatmap': (a) => a.setDepthHeatmapEnabled(false),
  'depth-delta': (a) => a.setDepthDeltaEnabled(false),
  'broker-late-entry': (a) => a.setBrokerLateEntryEnabled(false),
};

/** 눈(숨김) dispatch — id → hidden setter. */
const FLAG_SET_HIDDEN: Record<LegendFlagId, (a: IndicatorActions, hidden: boolean) => void> = {
  'ask-peak': (a, h) => a.setAskPeakHidden(h),
  'bid-peak': (a, h) => a.setBidPeakHidden(h),
  'trade-volume-poc': (a, h) => a.setTradeVolumePocHidden(h),
  'depth-heatmap': (a, h) => a.setDepthHeatmapHidden(h),
  'depth-delta': (a, h) => a.setDepthDeltaHidden(h),
  'broker-late-entry': (a, h) => a.setBrokerLateEntryHidden(h),
};

function MaLegendRow({ row }: { row: Extract<LegendRow, { kind: 'ma' }> }) {
  const setHidden = useIndicatorActions().setMovingAverageHidden;
  const setEnabled = useIndicatorActions().setMovingAverageEnabled;
  return (
    <>
      <span style={{ color: 'var(--fg-dim)' }}>이동평균선</span>
      {row.mas.map((m) => (
        <span
          key={m.id}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2xs)' }}
        >
          <span aria-hidden="true" style={{ ...swatchStyle, background: m.color }} />
          <span style={{ color: 'var(--fg-dim)' }}>{m.period}</span>
          <span style={valueCellStyle}>{m.value == null ? '—' : formatKoreanInt(m.value)}</span>
        </span>
      ))}
      <HoverIcon
        label="이동평균선 선 숨김/표시"
        restColor={row.hidden ? 'var(--fg-dim)' : 'var(--fg-dimmer)'}
        onClick={() => setHidden(!row.hidden)}
      >
        <EyeGlyph hidden={row.hidden} />
      </HoverIcon>
      <HoverIcon label="이동평균선 지표 끄기" restColor="var(--fg-dimmer)" onClick={() => setEnabled(false)}>
        <CloseGlyph />
      </HoverIcon>
    </>
  );
}

function DailyMaLegendRow({ row }: { row: Extract<LegendRow, { kind: 'daily-ma' }> }) {
  const setHidden = useIndicatorActions().setDailyMovingAverageHidden;
  const setEnabled = useIndicatorActions().setDailyMovingAverageEnabled;
  return (
    <>
      <span style={{ color: 'var(--fg-dim)' }}>일봉 이동평균선</span>
      {row.mas.map((m) => (
        <span
          key={m.id}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2xs)' }}
        >
          <span aria-hidden="true" style={{ ...swatchStyle, background: m.color }} />
          <span style={{ color: 'var(--fg-dim)' }}>{m.period}</span>
          <span style={valueCellStyle}>{m.value == null ? '—' : formatKoreanInt(m.value)}</span>
        </span>
      ))}
      <HoverIcon
        label="일봉 이동평균선 선 숨김/표시"
        restColor={row.hidden ? 'var(--fg-dim)' : 'var(--fg-dimmer)'}
        onClick={() => setHidden(!row.hidden)}
      >
        <EyeGlyph hidden={row.hidden} />
      </HoverIcon>
      <HoverIcon label="일봉 이동평균선 지표 끄기" restColor="var(--fg-dimmer)" onClick={() => setEnabled(false)}>
        <CloseGlyph />
      </HoverIcon>
    </>
  );
}

function FlagLegendRow({ row }: { row: Extract<LegendRow, { kind: 'flag' }> }) {
  const indicatorActions = useIndicatorActions();
  // 색 있는 값 셀(히트맵 매수/매도, 거래원 매수/매도)이 있으면 행 스와치는 중복 —
  // 셀 스와치만 남긴다. 무색 셀(벽 가격, POC)은 행 스와치가 지표 색을 대표.
  const showRowSwatches = !row.cells.some((c) => c.color);
  return (
    <>
      {/* 요소 순서는 MA row와 통일: 라벨 → 색상 → 수치. */}
      <span style={{ color: 'var(--fg-dim)' }}>{row.label}</span>
      {showRowSwatches
        && row.swatches.map((color, i) => (
          <span key={i} aria-hidden="true" style={{ ...swatchStyle, background: color }} />
        ))}
      {row.cells.map((c) => (
        <span
          key={c.key}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2xs)' }}
        >
          {c.color && <span aria-hidden="true" style={{ ...swatchStyle, background: c.color }} />}
          {c.label && <span style={{ color: 'var(--fg-dim)' }}>{c.label}</span>}
          <span style={valueCellStyle}>{c.value}</span>
        </span>
      ))}
      <HoverIcon
        label={`${row.label} 표시 숨김/표시`}
        restColor={row.hidden ? 'var(--fg-dim)' : 'var(--fg-dimmer)'}
        onClick={() => FLAG_SET_HIDDEN[row.id](indicatorActions, !row.hidden)}
      >
        <EyeGlyph hidden={row.hidden} />
      </HoverIcon>
      <HoverIcon
        label={`${row.label} 지표 끄기`}
        restColor="var(--fg-dimmer)"
        onClick={() => FLAG_TURN_OFF[row.id](indicatorActions)}
      >
        <CloseGlyph />
      </HoverIcon>
    </>
  );
}

function CellsLegendRow({
  row,
  timeframe,
}: {
  row: Extract<LegendRow, { kind: 'cells' }>;
  timeframe: LiveTimeframe;
}) {
  const setPanePrefForTimeframe = useIndicatorActions().setPanePrefForTimeframe;
  const toggleKey = row.toggleKey;
  const turnOff = toggleKey
    ? () => setPanePrefForTimeframe(timeframe, toggleKey, false)
    : undefined;
  const offLabel = `${row.title ?? row.cells[0]?.label ?? ''} 지표 끄기`;
  return (
    <>
      {row.title && <span style={{ color: 'var(--fg-dim)' }}>{row.title}</span>}
      {row.cells.map((c) => (
        <span
          key={c.key}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2xs)' }}
        >
          {c.color && <span aria-hidden="true" style={{ ...swatchStyle, background: c.color }} />}
          <span style={{ color: 'var(--fg-dim)' }}>{c.label}</span>
          <span style={valueCellStyle}>{c.formatted}</span>
        </span>
      ))}
      {turnOff && (
        <HoverIcon label={offLabel} restColor="var(--fg-dimmer)" onClick={turnOff}>
          <CloseGlyph />
        </HoverIcon>
      )}
    </>
  );
}

function PaneLegendOverlay({ chart, timeframe, paneToggles, hasDepthDelta = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Last crosshair param (null = cursor away → latest-fallback). Mutated by the
  // subscription, read during render; a tick (below) re-renders after each
  // mutation so the read stays consistent with React state.
  const paramRef = useRef<MouseEventParams | null>(null);
  const [, tick] = useReducer((n: number) => n + 1, 0);

  // 사용자 소유 pane 순서 — 내부 구독이라 memo(props)를 우회해 재정렬 즉시 반영.
  const paneOrder = useWindowPaneOrder();
  // 플래그 값 provider 의 창 스코프 — 등록(각 오버레이)과 **같은 키**로 읽어야 한다.
  // 한쪽만 스코프하면 값이 통째로 사라지거나 옆 창 값을 그대로 보게 된다.
  const windowId = useWindowScopeId();
  const movingAverages = useWindowIndicator((s) => s.movingAverages);
  const movingAverageEnabled = useWindowIndicator((s) => s.movingAverageEnabled);
  const movingAverageHidden = useWindowIndicator((s) => s.movingAverageHidden);
  const dailyMovingAverages = useWindowIndicator((s) => s.dailyMovingAverages);
  const dailyMovingAverageEnabled = useWindowIndicator((s) => s.dailyMovingAverageEnabled);
  const dailyMovingAverageHidden = useWindowIndicator((s) => s.dailyMovingAverageHidden);
  // Candle-pane flag indicators — enabled/hidden flags + swatch colors (설정 변경 즉시 반영).
  const askPeakEnabled = useWindowIndicator((s) => s.askPeakEnabled);
  const askPeakHidden = useWindowIndicator((s) => s.askPeakHidden);
  const askPeakColor = useWindowIndicator((s) => s.askPeakColor);
  const bidPeakEnabled = useWindowIndicator((s) => s.bidPeakEnabled);
  const bidPeakHidden = useWindowIndicator((s) => s.bidPeakHidden);
  const bidPeakColor = useWindowIndicator((s) => s.bidPeakColor);
  const tradeVolumePocEnabled = useWindowIndicator((s) => s.tradeVolumePocEnabled);
  const tradeVolumePocHidden = useWindowIndicator((s) => s.tradeVolumePocHidden);
  const tradeVolumePocColor = useWindowIndicator((s) => s.tradeVolumePocColor);
  const depthHeatmapEnabled = useWindowIndicator((s) => s.depthHeatmapEnabled);
  const depthHeatmapHidden = useWindowIndicator((s) => s.depthHeatmapHidden);
  const depthHeatmapBidColor = useWindowIndicator((s) => s.depthHeatmapBidColor);
  const depthHeatmapAskColor = useWindowIndicator((s) => s.depthHeatmapAskColor);
  const depthDeltaEnabled = useWindowIndicator((s) => s.depthDeltaEnabled);
  const depthDeltaHidden = useWindowIndicator((s) => s.depthDeltaHidden);
  const depthDeltaInColor = useWindowIndicator((s) => s.depthDeltaInColor);
  const depthDeltaOutColor = useWindowIndicator((s) => s.depthDeltaOutColor);
  const brokerLateEntryEnabled = useWindowIndicator((s) => s.brokerLateEntryEnabled);
  const brokerLateEntryHidden = useWindowIndicator((s) => s.brokerLateEntryHidden);
  const brokerLateEntrySideMode = useWindowIndicator((s) => s.brokerLateEntrySideMode);
  const brokerLateEntryBuyColor = useWindowIndicator((s) => s.brokerLateEntryBuyColor);
  const brokerLateEntrySellColor = useWindowIndicator((s) => s.brokerLateEntrySellColor);
  const maSeries = useMaSeriesRegistry((s) => s.series);
  const dailyMaSeries = useDailyMaSeriesRegistry((s) => s.series);
  // Registry subscription: re-renders on pane (un)mount so a toggled-on pane's
  // legend appears without waiting for a crosshair move.
  const legendPanes = usePaneLegendRegistry((s) => s.panes);

  // Crosshair → values; ResizeObserver + range change → pane geometry. All
  // coalesced through one rAF tick (DrawingOverlay's redraw-loop pattern).
  useEffect(() => {
    const ts = chart.timeScale();
    let raf = 0;
    const schedule = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        tick();
      });
    };
    const onCrosshair = (param: MouseEventParams) => {
      paramRef.current = param.point == null ? null : param;
      schedule();
    };
    chart.subscribeCrosshairMove(onCrosshair);
    ts.subscribeVisibleLogicalRangeChange(schedule);
    const ro =
      containerRef.current && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(schedule)
        : null;
    if (ro && containerRef.current) ro.observe(containerRef.current);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      chart.unsubscribeCrosshairMove(onCrosshair);
      ts.unsubscribeVisibleLogicalRangeChange(schedule);
      ro?.disconnect();
    };
  }, [chart]);

  // ── runtime pane order (spec) — drives both cell metadata and Y placement ──
  const specs = paneSpecsForTimeframe(timeframe, paneToggles, paneOrder);
  const specByPaneId = new Map<string, (typeof specs)[number]>();
  specs.forEach((s) => {
    specByPaneId.set(s.name, s);
  });

  // ── value extraction (read-only over the chart API) ────────────────────
  const seriesData = paramRef.current?.seriesData ?? null;
  const maValues = new Map<string, number>();
  for (const [id, series] of maSeries) {
    const v = readSeriesValue(series, seriesData);
    if (v !== null) maValues.set(id, v);
  }
  const dailyMaValues = new Map<string, number>();
  for (const [id, series] of dailyMaSeries) {
    const v = readSeriesValue(series, seriesData);
    if (v !== null) dailyMaValues.set(id, v);
  }
  const paneCells: PaneCellInput[] = [];
  for (const [paneId, entries] of legendPanes) {
    const spec = specByPaneId.get(paneId);
    paneCells.push({
      paneId,
      title: spec?.legendTitle,
      toggleKey: spec?.legendToggleKey,
      cells: entries.map((entry, i) => ({
        key: `${paneId}:${i}`,
        label: entry.meta.label,
        color: entry.meta.color?.(),
        value: readSeriesValue(entry.series, seriesData),
        format: entry.meta.format,
      })),
    });
  }

  // 플래그 지표 — 모두 분봉 전용 오버레이(각자의 마운트 게이트를 미러링).
  // 표시 순서 = 이 배열 순서. 거래원 등장 마커는 ratio pane에 붙으므로(RATIO_SPEC
  // labelMarkers) 그쪽에 배치 — pane 미마운트(호가비 off) 시 배치 단계에서 스킵.
  // 값 셀은 각 오버레이가 등록한 provider에서 커서 시각(가상초, 없으면 latest)으로 읽는다.
  const isMinute = isMinuteTimeframe(timeframe);
  const cursorTimeSec = typeof paramRef.current?.time === 'number' ? paramRef.current.time : null;
  const indicatorFlags: LegendFlagInput[] = [
    {
      id: 'ask-peak',
      paneId: 'candle',
      label: '당일 매도 최대벽',
      enabled: askPeakEnabled,
      applicable: isMinute,
      hidden: askPeakHidden,
      swatches: [askPeakColor],
      cells: readFlagLegendValues(windowId, 'ask-peak', cursorTimeSec),
    },
    {
      id: 'bid-peak',
      paneId: 'candle',
      label: '당일 매수 최대벽',
      enabled: bidPeakEnabled,
      applicable: isMinute,
      hidden: bidPeakHidden,
      swatches: [bidPeakColor],
      cells: readFlagLegendValues(windowId, 'bid-peak', cursorTimeSec),
    },
    {
      id: 'trade-volume-poc',
      paneId: 'candle',
      label: '당일 최대 매물대',
      enabled: tradeVolumePocEnabled,
      applicable: isMinute,
      hidden: tradeVolumePocHidden,
      swatches: [tradeVolumePocColor],
      cells: readFlagLegendValues(windowId, 'trade-volume-poc', cursorTimeSec),
    },
    {
      id: 'depth-heatmap',
      paneId: 'candle',
      label: '호가 잔량 히트맵',
      enabled: depthHeatmapEnabled,
      applicable: isMinute,
      hidden: depthHeatmapHidden,
      swatches: [depthHeatmapBidColor, depthHeatmapAskColor],
      cells: readFlagLegendValues(windowId, 'depth-heatmap', cursorTimeSec),
    },
    {
      id: 'depth-delta',
      paneId: 'candle',
      label: '단별 잔량 증감',
      enabled: depthDeltaEnabled,
      // applicable 은 오버레이 마운트 게이트(shouldShowDepthDeltaOverlay)와 **같은
      // 3조건**이어야 한다 — 어긋나면 그려지지 않는 지표의 빈 행이 레전드에 남는다.
      // 이 지표만 데이터 유무까지 보는 이유: 오늘 SSE 가 유일한 소스라 /study·과거일
      // 전용 뷰에서는 켜져 있어도 그릴 것이 없다(히트맵은 과거일 소스가 있어 무관).
      applicable: isMinute && hasDepthDelta,
      hidden: depthDeltaHidden,
      swatches: [depthDeltaInColor, depthDeltaOutColor],
      cells: readFlagLegendValues('depth-delta', cursorTimeSec),
    },
    {
      id: 'broker-late-entry',
      paneId: 'ratio',
      label: '신규 거래원 등장',
      enabled: brokerLateEntryEnabled,
      applicable: isMinute,
      hidden: brokerLateEntryHidden,
      // side mode에 따라 실제 그려지는 쪽의 스와치만 노출.
      swatches:
        brokerLateEntrySideMode === 'buy'
          ? [brokerLateEntryBuyColor]
          : brokerLateEntrySideMode === 'sell'
            ? [brokerLateEntrySellColor]
            : [brokerLateEntryBuyColor, brokerLateEntrySellColor],
      cells: readFlagLegendValues(windowId, 'broker-late-entry', cursorTimeSec),
    },
  ];

  const rows = buildLegendRows({
    movingAverages,
    movingAverageEnabled,
    movingAverageHidden,
    maValues,
    dailyMovingAverages,
    dailyMovingAverageEnabled,
    dailyMovingAverageHidden,
    dailyMaValues,
    dailyMaApplicable: isMinute,
    indicatorFlags,
    paneCells,
  });

  // ── pane geometry (runtime order, not static paneTopY) ─────────────────
  let panes: ReturnType<IChartApi['panes']> = [];
  try {
    panes = chart.panes();
  } catch {
    panes = []; // chart tearing down
  }
  const paneTops: number[] = [];
  {
    let acc = 0;
    for (const p of panes) {
      paneTops.push(acc);
      acc += p.getHeight();
    }
  }

  // Group rows per pane — the candle pane can hold several (MA + daily-MA +
  // flag chips), stacked vertically inside one absolutely-positioned wrapper.
  const rowsByPane = new Map<string, LegendRow[]>();
  for (const row of rows) {
    const list = rowsByPane.get(row.paneId);
    if (list) list.push(row);
    else rowsByPane.set(row.paneId, [row]);
  }

  return (
    <div
      ref={containerRef}
      data-testid="pane-legend-overlay"
      // pointer-events:none keeps the crosshair alive under the legend; only
      // the icon buttons re-enable hits (iconBtnStyle).
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 4 }}
    >
      {/* 마운트된 pane 순서(specs)로 순회 — 레전드 행이 없는 pane 도 래퍼를 받아
          ↑/↓ 순서 컨트롤을 노출한다. 캔들(idx 0)은 컨트롤 없이 행만 렌더. */}
      {specs.map((spec, idx) => {
        const paneId = spec.name;
        // Pane not mounted yet (first frame after a toggle/reorder) → skip;
        // self-heals next tick once chart.panes() includes it.
        if (idx >= paneTops.length) return null;
        const paneRows = rowsByPane.get(paneId) ?? [];
        const showMoveControls = idx > 0; // 캔들은 고정
        if (paneRows.length === 0 && !showMoveControls) return null;
        return (
          <div
            key={paneId}
            style={{
              position: 'absolute',
              top: `calc(${paneTops[idx]}px + ${LEGEND_INSET})`,
              left: LEGEND_INSET,
              right: LEGEND_INSET,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gap: 'var(--space-2xs)',
              pointerEvents: 'none',
            }}
          >
            {showMoveControls && (
              <PaneMoveControls
                paneId={paneId}
                label={spec.legendTitle ?? paneId}
                idx={idx}
                mountedCount={Math.min(specs.length, paneTops.length)}
                upNeighbor={idx - 1 >= 0 ? specs[idx - 1].name : null}
                downNeighbor={idx + 1 < specs.length ? specs[idx + 1].name : null}
                paneOrder={paneOrder}
              />
            )}
            {paneRows.map((row) => (
              <div
                // paneId+kind(+flag id): 캔들 pane은 MA/daily-MA/flag row가 공존 —
                // key 충돌 예방.
                key={row.kind === 'flag' ? `${row.paneId}:flag:${row.id}` : `${row.paneId}:${row.kind}`}
                style={boxStyle}
              >
                {row.kind === 'ma' ? (
                  <MaLegendRow row={row} />
                ) : row.kind === 'daily-ma' ? (
                  <DailyMaLegendRow row={row} />
                ) : row.kind === 'flag' ? (
                  <FlagLegendRow row={row} />
                ) : (
                  <CellsLegendRow row={row} timeframe={timeframe} />
                )}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// P1: memo로 부모(LiveChartRoot)의 SSE 호가 틱 재렌더를 차단 — props(chart/timeframe/
// paneToggles/dataEpoch)가 동일하면 재렌더 안 함. 크로스헤어/스토어/레지스트리 변경은
// 내부 구독/셀렉터가 재렌더하므로 memo와 무관하게 동작한다. 호가-경로 pane의 커서-idle
// latest가 캔들 epoch 주기로만 신선화되는 것은 의도된 트레이드오프 — dataEpoch prop
// JSDoc 참조.
export default memo(PaneLegendOverlay);
