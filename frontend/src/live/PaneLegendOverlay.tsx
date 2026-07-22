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

import { memo, useEffect, useMemo, useReducer, useRef, type CSSProperties } from 'react';
import type { IChartApi, MouseEventParams } from 'lightweight-charts';
import { isMinuteTimeframe, type LiveTimeframe } from '../state/livePage';
import type { Candle } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import { priceDirClass } from '../ui/priceDir';
import { buildCandleTooltip } from './candleTooltipModel';
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
import type { BoundPaneSpec } from '../chart/paneSpecs';
import type { PaneId } from '../chart/drawing/types';
import { movePaneBeside } from '../chart/paneOrder';
import {
  buildLegendRows,
  readSeriesValue,
  type LegendFlagId,
  type LegendFlagInput,
  type LegendOhlcValues,
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
  /** 접기(`paneFolding.ts`) 적용 후 실제로 마운트된 pane 목록. 주면 이걸 쓰고,
   *  없으면 게이트 결과를 그대로 계산한다. 접힌 pane 이 섞이면 pane 이동 컨트롤의
   *  "아래로" 가 보이지 않는 pane 을 가리켜 클릭해도 아무 일도 안 하는 것처럼 보인다. */
  visibleSpecs?: readonly BoundPaneSpec[];
  /** 캔들 pane 최상단 OHLC 레전드(항상 표시)용 캔들 배열 + 가상축. `axis` 로
   *  그려진(보이는) 봉만 추려 `param.time`(가상초)→봉을 해석하고, 커서 밖이면 최신
   *  봉으로 폴백한다(CandleTooltip 과 동일 인덱싱). 둘 다 캔들 경로/segments 참조라
   *  SSE 틱엔 안정 — memo 를 깨지 않는다. 없으면 OHLC 행을 렌더하지 않는다. */
  candles?: readonly Candle[];
  axis?: VirtualAxis;
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
  // 반투명 surface (2026-07-21). 차트 배경=bg-card라 빈 영역에선 원래도 녹아들었고,
  // 불투명 채움은 캔들 위에 겹칠 때의 대비만 담당했다 — 그 대비를 70%로 낮춰
  // 아래 캔들이 비치게 하되 텍스트는 여전히 읽히는 선을 잡는다. 외곽선(border)이
  // 없는 상태(2026-07-15 borderless)는 유지.
  background: 'var(--bg-legend)',
  borderRadius: 'var(--radius-md)',
  padding: 'var(--space-2xs) var(--space-sm)',
  fontFamily: 'var(--font-data)',
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

// MA/일봉MA 값은 양수 KRX 가격(최대 ~9자 "9,999,999")이라 OHLC 음수 최악값용 12ch
// 대신 9ch 만 예약 — 반사(reflow) 방지는 유지하되 칸마다 남던 여백을 줄인다. flag·cells
// 행은 음수(단별 잔량 증감)·큰 수(총잔량)가 있어 공용 12ch 를 그대로 쓴다.
const maValueCellStyle: CSSProperties = {
  minWidth: '9ch',
  textAlign: 'right',
  color: 'var(--fg)',
  fontVariantNumeric: 'tabular-nums',
};

// MA 값 셀: 값이 있으면 9ch 우측정렬, 없으면(cold/범위 밖) min-width 없이 "—" 만 —
// 값 없는 슬롯이 넓은 빈 칸을 예약해 레전드가 성겨 보이던 문제를 없앤다.
function MaValueCell({ value }: { value: number | null }) {
  if (value == null) return <span style={{ color: 'var(--fg-dimmer)' }}>—</span>;
  return <span style={maValueCellStyle}>{formatKoreanInt(value)}</span>;
}

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

const signedPct = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';

/** OHLC 한 칸: 라벨(저채도) + 가격(중립) + 직전종가 대비 %(부호색, 괄호). pct 없으면
 *  (가장 이른 봉) % 는 생략. 색·텍스트 모두 반올림값 기준(툴팁 PriceRow 선례). */
function OhlcCell({ label, price, pct }: { label: string; price: number; pct: number | null }) {
  const r = pct != null && Number.isFinite(pct) ? Number(pct.toFixed(2)) : null;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2xs)' }}>
      <span style={{ color: 'var(--fg-dim)' }}>{label}</span>
      <span style={{ color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}>
        {formatKoreanInt(price)}원
      </span>
      {r != null && (
        <span className={priceDirClass(r)} style={{ fontVariantNumeric: 'tabular-nums' }}>
          ({signedPct(r)})
        </span>
      )}
    </span>
  );
}

/** 캔들 pane 최상단 OHLC 행 — 시작/고가/저가/종가 + 직전종가 대비 %. 토글 없음(항상 표시). */
function OhlcLegendRow({ row }: { row: Extract<LegendRow, { kind: 'ohlc' }> }) {
  return (
    <>
      <OhlcCell label="시작" price={row.open} pct={row.openPct} />
      <OhlcCell label="고가" price={row.high} pct={row.highPct} />
      <OhlcCell label="저가" price={row.low} pct={row.lowPct} />
      <OhlcCell label="종가" price={row.close} pct={row.closePct} />
    </>
  );
}

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
          {/* 색 점 + 회색 기간 2요소를 "색 입힌 기간" 1요소로 통합(밀집도 개선 B). */}
          <span style={{ color: m.color, fontWeight: 500 }}>{m.period}</span>
          <MaValueCell value={m.value} />
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
          {/* 색 점 + 회색 기간 2요소를 "색 입힌 기간" 1요소로 통합(밀집도 개선 B). */}
          <span style={{ color: m.color, fontWeight: 500 }}>{m.period}</span>
          <MaValueCell value={m.value} />
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

function PaneLegendOverlay({
  chart,
  timeframe,
  paneToggles,
  hasDepthDelta = false,
  visibleSpecs,
  candles,
  axis,
}: Props) {
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

  // OHLC 레전드용 인덱싱 — 그려진(보이는) 봉 배열 + 가상초→index 맵(CandleTooltip 선례).
  // candles/axis 는 캔들 경로/segments 참조라 SSE 틱엔 재계산 안 됨. 팬/줌(axis 리베이스)·
  // 캔들 갱신 때만 새로.
  const drawnCandles = useMemo(
    () => (candles && axis ? candles.filter((c) => axis.contains(c.ts_ms)) : []),
    [candles, axis],
  );
  const vsecToIndex = useMemo(() => {
    const m = new Map<number, number>();
    if (axis) drawnCandles.forEach((c, i) => m.set(axis.toVirtual(c.ts_ms) / 1000, i));
    return m;
  }, [drawnCandles, axis]);

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
  const specs = visibleSpecs ?? paneSpecsForTimeframe(timeframe, paneToggles, paneOrder);
  const specByPaneId = new Map<string, (typeof specs)[number]>();
  specs.forEach((s) => {
    specByPaneId.set(s.name, s);
  });

  // ── value extraction (read-only over the chart API) ────────────────────
  const seriesData = paramRef.current?.seriesData ?? null;

  // OHLC(항상 표시) — 커서가 올라간 봉(param.time=가상초)을 해석하고, 커서 밖/봉 사이면
  // 최신 봉으로 폴백. 직전종가 대비 %는 buildCandleTooltip(순수, 툴팁과 동일 규칙)에서.
  let ohlc: LegendOhlcValues | null = null;
  if (drawnCandles.length > 0) {
    const t = typeof paramRef.current?.time === 'number' ? paramRef.current.time : null;
    const idx = (t !== null ? vsecToIndex.get(t) : undefined) ?? drawnCandles.length - 1;
    const m = buildCandleTooltip(drawnCandles, idx, timeframe);
    if (m) {
      ohlc = {
        open: m.open,
        high: m.high,
        low: m.low,
        close: m.close,
        openPct: m.openPct,
        highPct: m.highPct,
        lowPct: m.lowPct,
        closePct: m.closePct,
      };
    }
  }
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
      cells: readFlagLegendValues(windowId, 'depth-delta', cursorTimeSec),
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
    ohlc,
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
  const paneHeights: number[] = [];
  {
    let acc = 0;
    for (const p of panes) {
      const h = p.getHeight();
      paneTops.push(acc);
      paneHeights.push(h);
      acc += h;
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
              // 자기 pane 안으로 가둔다. 캔들 pane 은 행이 6줄까지(MA·일봉MA·최대벽
              // 2종·매물대·히트맵) 쌓이는데, 창이 작아지면 그 높이가 pane 을 넘어
              // 차트 밖으로 흘러나가 잘렸다. 클램프하면 들어가는 행은 그대로 보이고
              // 넘치는 행만 자기 pane 경계에서 끊긴다 — 레전드는 원래 캔들 위에
              // 겹쳐 그리는 물건이라 pane 안에서의 클리핑은 계약 위반이 아니다.
              maxHeight: `calc(${paneHeights[idx]}px - ${LEGEND_INSET})`,
              overflow: 'hidden',
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
                {row.kind === 'ohlc' ? (
                  <OhlcLegendRow row={row} />
                ) : row.kind === 'ma' ? (
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
