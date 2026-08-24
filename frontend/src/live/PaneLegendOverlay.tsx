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

import { memo, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from 'react';
import type { IChartApi, MouseEventParams } from 'lightweight-charts';
import { isMinuteTimeframe, type LiveTimeframe } from '../state/livePage';
import { useScopedChartPrefs } from '../state/chartPrefs';
import type { Candle } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import { useCursorSyncResolution } from './useCursorSyncResolution';
import { priceDirClass } from '../ui/priceDir';
import { buildCandleTooltip } from './candleTooltipModel';
import {
  useIndicatorActions,
  useWindowIndicator,
  useWindowPaneAxisMode,
  useWindowPaneGroups,
  useWindowScopeId,
  type IndicatorActions,
} from './workspace/windowView';
import { useMaSeriesRegistry } from './indicators/maSeriesRegistry';
import { useDailyMaSeriesRegistry } from './indicators/dailyMaSeriesRegistry';
import { usePaneLegendRegistry } from './indicators/paneLegendRegistry';
import { scopeEntries } from './indicators/windowScopedRegistry';
import type { PaneToggles } from './paneSpecsForTimeframe';
import { paneGroupIds, paneGroupSpecsForTimeframe, type PaneSpecGroup } from './paneGroupSpecs';
import type { PaneId } from '../chart/drawing/types';
import { PANE_DISPLAY_NAME } from '../chart/paneOrder';
import {
  extractPaneToBoundary,
  mergePaneIntoGroup,
  movePaneGroupBeside,
  paneGroupIndexOf,
  resolveAxisMode,
  type PaneGroups,
} from '../chart/paneGroups';
import {
  boundaryDropLabel,
  classifyPaneDropTarget,
  fullBoundaryIndex,
  mergeDropHint,
  PANE_DRAG_THRESHOLD_PX,
  type PaneDropTarget,
} from './paneMergeDrag';
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
import { safeUnsubscribe } from '../chart/util/safeUnsubscribe';

type Props = {
  chart: IChartApi;
  timeframe: LiveTimeframe;
  paneToggles: PaneToggles;
  /** 단별 잔량 증감 데이터 유무. 이 지표는 오늘 SSE 에서만 나오므로 /study 나 과거일
   *  전용 뷰에서는 켜져 있어도 그릴 것이 없다 — 그때 값 없는 빈 레전드 행이 남지 않도록
   *  `applicable` 을 데이터 유무까지 좁힌다(오버레이 마운트 게이트와 일치시키는 규약). */
  hasDepthDelta?: boolean;
  /** 접기(`paneFolding.ts`) 적용 후 실제로 마운트된 pane **그룹** 목록(병합 반영).
   *  주면 이걸 쓰고, 없으면 게이트 결과를 그대로 계산한다. 접힌 pane 이 섞이면 pane
   *  이동 컨트롤의 "아래로" 가 보이지 않는 pane 을 가리켜 클릭해도 아무 일도 안 하는
   *  것처럼 보인다. */
  visibleGroups?: readonly PaneSpecGroup[];
  /** 캔들 pane 최상단 OHLC 레전드(항상 표시)용 캔들 배열 + 가상축. `axis` 로
   *  그려진(보이는) 봉만 추려 `param.time`(가상초)→봉을 해석하고, 커서 밖이면 최신
   *  봉으로 폴백한다(CandleTooltip 과 동일 인덱싱). 둘 다 캔들 경로/segments 참조라
   *  SSE 틱엔 안정 — memo 를 깨지 않는다. 없으면 OHLC 행을 렌더하지 않는다. */
  candles?: readonly Candle[];
  axis?: VirtualAxis;
  /** 이 창의 종목 — 크로스헤어 동기화의 종목 게이트에 쓴다(`useCursorSyncResolution`). */
  code?: string | null;
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

/** cells 행(pane 레전드의 값 표시)을 노출하는 pane 화이트리스트. 2026-07-22 에 밀집도
 *  때문에 전 pane 을 숨겼다가, 거래량·총잔량을 되살렸고(2026-08-04) 프로그램 순매수가
 *  뒤따랐다(2026-08-18). 레전드 메타는 projector(`SeriesSpec.legend`)가 계속 전 pane 에
 *  대해 등록하므로, 다른 pane 을 되살리려면 여기에 PaneId 를 추가하기만 하면 된다.
 *  `/live` 와 `/study` 가 같은 `LiveChartRoot` 를 쓰므로 두 화면에 동시에 적용된다.
 *
 *  ⚠ 여기에 pane 을 추가하면 그 pane 의 `lastValueVisible`(가격축 최신값 칩)을 **같이
 *  꺼야 한다**. 두 판독면은 갱신 주기가 다르다 — 축 칩은 SSE 재투영을 따라 거의
 *  실시간이고 레전드 latest 는 캔들 epoch 주기(아래 `dataEpoch` 주석)라, 둘 다 켜면
 *  장중에 같은 시리즈가 서로 다른 숫자로 보인다. 프로그램 순매수가 그 경우였다
 *  (DESIGN.md 2026-08-18). */
const LEGEND_CELL_PANES: ReadonlySet<PaneId> = new Set<PaneId>([
  'volume',
  'quote-totals',
  'program-trade',
  // 최대벽 강도 pane — 계단의 현재 높이가 곧 「오늘 최대」라 커서 없이도 읽을 값이
  // 있다(flag 행을 되살린 근거와 동일). 스펙이 lastValueVisible:false 라 위 ⚠ 의
  // 이중 판독면 조건도 충족한다.
  'peak-wall',
]);

/** flag 행(값 없는 오버레이 지표)의 표시 화이트리스트 — `LEGEND_CELL_PANES` 와 같은 성격.
 *  2026-07-22 에 캔들 pane 밀집도 때문에 flag 행을 **전부** 숨겼다. 당일 최대벽 두 행만
 *  2026-08-22 에 되살린다(사용자 요청): 값이 「커서가 올라간 거래일의 벽 1개」에서
 *  「보이는 영역 잔량 상위 3개」로 바뀌어, 커서를 따라다니는 단발 판독이 아니라 **화면
 *  전체의 요약**이 됐다 — 커서를 올리지 않아도 읽을 값이 있으므로 레전드 자리가 정당하다.
 *  나머지 flag(매물대·히트맵·단별잔량·신규거래원)는 계속 숨긴다.
 *
 *  ⚠ 상위 3개가 비어도(보이는 범위에 벽 없음) 행은 남는다 — 행을 지우면 눈·✕ 가 함께
 *  사라져 레전드에서 지표를 끌 수 없다. */
const LEGEND_FLAG_IDS: ReadonlySet<LegendFlagId> = new Set<LegendFlagId>([
  'ask-peak',
  'bid-peak',
]);

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
        // 크기 override 없음 — iconBtnStyle 의 18px 를 그대로 쓴다. legend 행과 같은
        // 줄에 놓이므로 두 칩의 높이가 어긋나면 단차가 그대로 보이는데, 행 높이를
        // 정하는 것은 텍스트(line-height 14.7px)가 아니라 **✕ 버튼(18px)**이다
        // (실측: 행 22px = 18 + 상하 패딩 2×2, 컨트롤 칩도 같은 패딩). 그래서 여기서
        // 크기를 줄이면(이전 16px) 반드시 어긋난다.
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

/** 한 pane(그룹)의 ↑/↓ 순서 이동 컨트롤. candle(idx 0)은 렌더하지 않는다. 이동은
 *  **마운트된 이웃 그룹 곁으로의 인접 삽입**이라 게이트로 부재중인 pane 을 건너뛴다
 *  (ADR-0114 §3). 병합 pane 은 **그룹 전체**가 한 덩어리로 움직인다.
 *
 *  배치: legend 행과 **같은 줄의 pane 우측 끝**(2026-08-18). 우측 끝은 컨테이너가
 *  아니라 **플롯 우측**이다 — 래퍼의 `rightInset` 이 가격축 거터를 뺀다. */
function PaneMoveControls({
  paneId,
  label,
  idx,
  mountedCount,
  upNeighbor,
  downNeighbor,
  paneGroups,
}: {
  /** 그룹 대표(첫 멤버) — 이동 연산·testId 의 앵커. */
  paneId: PaneId;
  label: string;
  idx: number;
  mountedCount: number;
  /** 바로 위/아래에 **마운트된** 이웃 그룹의 대표(게이트로 부재중인 pane 은 건너뛴 값). */
  upNeighbor: PaneId | null;
  downNeighbor: PaneId | null;
  paneGroups: PaneGroups;
}) {
  const setPaneGroups = useIndicatorActions().setPaneGroups;
  // idx 1 의 위 이웃은 candle(고정) → 위로 이동 불가. 마지막 마운트 pane → 아래 불가.
  const canUp = idx > 1 && upNeighbor !== null && upNeighbor !== 'candle';
  const canDown = idx < mountedCount - 1 && downNeighbor !== null;
  return (
    <span
      style={{
        ...boxStyle,
        gap: 'var(--space-2xs)',
        pointerEvents: 'auto',
        padding: 'var(--space-2xs)',
        // 우측 정렬(marginLeft:auto)은 이제 감싸는 클러스터(칩 + 이동 버튼)가 갖는다.
        // boxStyle 의 `maxWidth:100%`+`overflow:hidden` 과 결합하면 좁은 pane 에서
        // 버튼이 잘린다. 잘려야 하는 쪽은 legend 행이고 컨트롤은 아니다.
        flexShrink: 0,
      }}
    >
      <PaneMoveButton
        dir="up"
        label={`${label} pane 위로 이동`}
        testId={`pane-move-up-${paneId}`}
        disabled={!canUp}
        onClick={() => { if (canUp && upNeighbor) setPaneGroups(movePaneGroupBeside(paneGroups, paneId, upNeighbor, 'before')); }}
      />
      <PaneMoveButton
        dir="down"
        label={`${label} pane 아래로 이동`}
        testId={`pane-move-down-${paneId}`}
        disabled={!canDown}
        onClick={() => { if (canDown && downNeighbor) setPaneGroups(movePaneGroupBeside(paneGroups, paneId, downNeighbor, 'after')); }}
      />
    </span>
  );
}

/** 드래그 그립(⠿) — 칩이 잡을 수 있는 물건임을 말한다. */
function GripGlyph() {
  return (
    <svg width="8" height="12" viewBox="0 0 8 12" aria-hidden="true">
      {[1.5, 6.5].map((x) =>
        [1.5, 6, 10.5].map((y) => (
          <circle key={`${x}:${y}`} cx={x} cy={y} r="1.1" fill="currentColor" />
        )))}
    </svg>
  );
}

/**
 * pane 이름 칩 — 병합/분리 드래그의 핸들이자(⠿·grab 커서), 클릭하면 병합 메뉴가
 * 열린다(드래그 임계값 `PANE_DRAG_THRESHOLD_PX` 미만의 pointerup = 클릭).
 * 병합 pane 의 멤버 칩에는 ✕(그 지표 끄기)가 붙고, 격리 스케일 그룹의 첫 칩에는
 * 「축」(오른쪽 축 소유), 'left' 모드의 둘째 칩에는 「좌축」 배지가 붙는다.
 */
function PaneChip({
  paneId,
  label,
  axisBadge,
  showRemove,
  onRemove,
  dimmed,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: {
  paneId: PaneId;
  label: string;
  /** 축 소유 배지 텍스트('축'·'좌축') — null 이면 배지 없음. */
  axisBadge: string | null;
  showRemove: boolean;
  onRemove: (() => void) | null;
  dimmed: boolean;
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel: () => void;
}) {
  return (
    <span
      data-testid={`pane-chip-${paneId}`}
      style={{
        ...boxStyle,
        gap: 'var(--space-2xs)',
        pointerEvents: 'auto',
        flexShrink: 0,
        color: 'var(--fg-dim)',
        cursor: 'grab',
        userSelect: 'none',
        touchAction: 'none',
        ...(dimmed ? { opacity: 0.35 } : null),
      }}
    >
      <button
        type="button"
        aria-label={`${label} pane 이동/병합`}
        title={`끌어서 다른 pane 에 합치거나 경계로 이동 · 클릭하면 메뉴`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        style={{
          ...iconBtnStyle,
          width: 'auto',
          gap: 'var(--space-2xs)',
          display: 'inline-flex',
          alignItems: 'center',
          color: 'inherit',
          cursor: 'inherit',
          touchAction: 'none',
        }}
      >
        <span aria-hidden="true" style={{ color: 'var(--fg-dimmer)', display: 'inline-flex' }}>
          <GripGlyph />
        </span>
        {label}
        {axisBadge !== null && (
          <span
            aria-label={axisBadge === '좌축' ? '왼쪽 축 눈금 소유' : '오른쪽 축 눈금 소유'}
            title={axisBadge === '좌축'
              ? '왼쪽 축 눈금은 이 지표의 것입니다'
              : '오른쪽 축 눈금은 이 지표의 것입니다'}
            style={{
              fontSize: 'var(--text-badge)',
              fontWeight: 700,
              color: 'var(--bg)',
              background: 'var(--accent)',
              borderRadius: 'var(--radius-sm)',
              padding: '0 var(--space-2xs)',
              lineHeight: 1.5,
            }}
          >
            {axisBadge}
          </span>
        )}
      </button>
      {showRemove && onRemove && (
        <HoverIcon label={`${label} 지표 끄기`} restColor="var(--fg-dimmer)" onClick={onRemove}>
          <CloseGlyph />
        </HoverIcon>
      )}
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
function OhlcCell({ label, price, pct, className }: { label: string; price: number; pct: number | null; className?: string }) {
  const r = pct != null && Number.isFinite(pct) ? Number(pct.toFixed(2)) : null;
  return (
    <span className={className} style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2xs)' }}>
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

/** 캔들 pane 최상단 OHLC 행 — 시작/고가/저가/종가 + 직전종가 대비 %. 토글 없음(항상 표시).
 *  좁은 창에서는 행 컨테이너의 overflow:hidden 이 글자 중간을 자르는 대신, pane 래퍼
 *  컨테이너 폭 기준으로 낮은 우선순위 셀부터 숨긴다(저가 → 고가 → 시작 — 종가+등락률이
 *  마지막까지 남는다). 규칙은 global.css `.legend-ohlc-*` 컨테이너 쿼리. */
function OhlcLegendRow({ row }: { row: Extract<LegendRow, { kind: 'ohlc' }> }) {
  return (
    <>
      <OhlcCell className="legend-ohlc-open" label="시작" price={row.open} pct={row.openPct} />
      <OhlcCell className="legend-ohlc-high" label="고가" price={row.high} pct={row.highPct} />
      <OhlcCell className="legend-ohlc-low" label="저가" price={row.low} pct={row.lowPct} />
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
  visibleGroups,
  candles,
  axis,
  code = null,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Last crosshair param (null = cursor away → latest-fallback). Mutated by the
  // subscription, read during render; a tick (below) re-renders after each
  // mutation so the read stays consistent with React state.
  const paramRef = useRef<MouseEventParams | null>(null);
  const [, tick] = useReducer((n: number) => n + 1, 0);

  // 사용자 소유 pane 레이아웃(그룹) — 내부 구독이라 memo(props)를 우회해 재정렬 즉시 반영.
  const paneGroups = useWindowPaneGroups();
  const paneAxisMode = useWindowPaneAxisMode();
  const indicatorActions = useIndicatorActions();

  // ── pane 병합 드래그 + 칩 메뉴 ──────────────────────────────────────────
  // 칩(pointer capture)에서 시작해 pane 본체(병합)/경계(이동·분리)로 떨어진다.
  // 판정은 `paneMergeDrag.ts` 의 순수 함수 — 지오메트리는 아래 렌더가 레전드 Y
  // 배치에 쓰는 것과 같은 값을 effect 로 미러한다(핸들러는 이벤트 시점에 읽는다).
  type PaneDragState = {
    pane: PaneId;
    label: string;
    fromMerged: boolean;
    x: number;
    y: number;
    target: PaneDropTarget | null;
  };
  const [paneDrag, setPaneDrag] = useState<PaneDragState | null>(null);
  const [chipMenu, setChipMenu] = useState<{ pane: PaneId; x: number; y: number } | null>(null);
  const dragOriginRef = useRef<{
    pane: PaneId; label: string; fromMerged: boolean; startX: number; startY: number;
  } | null>(null);
  const isDraggingRef = useRef(false);
  const geometryRef = useRef<{
    paneTops: number[]; paneHeights: number[]; groups: readonly PaneSpecGroup[];
  }>({ paneTops: [], paneHeights: [], groups: [] });

  const containerPoint = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = containerRef.current?.getBoundingClientRect();
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
  };
  const classifyAt = (pane: PaneId, yPx: number): PaneDropTarget | null => {
    const g = geometryRef.current;
    return classifyPaneDropTarget({
      yPx, paneTops: g.paneTops, paneHeights: g.paneHeights, groups: g.groups, draggedPane: pane,
    });
  };
  const chipPointerDown = (pane: PaneId, label: string, fromMerged: boolean) =>
    (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      dragOriginRef.current = { pane, label, fromMerged, startX: e.clientX, startY: e.clientY };
      // jsdom 에는 없다 — 실브라우저에서만 캡처(포인터가 칩 밖으로 나가도 move/up 수신).
      e.currentTarget.setPointerCapture?.(e.pointerId);
    };
  const chipPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const origin = dragOriginRef.current;
    if (!origin) return;
    if (!isDraggingRef.current) {
      const moved = Math.hypot(e.clientX - origin.startX, e.clientY - origin.startY);
      if (moved < PANE_DRAG_THRESHOLD_PX) return;
      isDraggingRef.current = true;
      setChipMenu(null);
    }
    const { x, y } = containerPoint(e);
    setPaneDrag({
      pane: origin.pane,
      label: origin.label,
      fromMerged: origin.fromMerged,
      x,
      y,
      target: classifyAt(origin.pane, y),
    });
  };
  const chipPointerUp = (e: React.PointerEvent<HTMLElement>) => {
    const origin = dragOriginRef.current;
    dragOriginRef.current = null;
    if (!origin) return;
    const { x, y } = containerPoint(e);
    if (!isDraggingRef.current) {
      // 임계값 미만 = 클릭 → 병합/분리 메뉴(비드래그 폴백 경로).
      setChipMenu((m) => (m?.pane === origin.pane ? null : { pane: origin.pane, x, y }));
      return;
    }
    isDraggingRef.current = false;
    setPaneDrag(null);
    const target = classifyAt(origin.pane, y);
    if (!target) return;
    if (target.kind === 'merge') {
      indicatorActions.setPaneGroups(mergePaneIntoGroup(paneGroups, origin.pane, target.targetPane));
    } else {
      indicatorActions.setPaneGroups(extractPaneToBoundary(
        paneGroups,
        origin.pane,
        fullBoundaryIndex(paneGroups, geometryRef.current.groups, target.boundaryIndex),
      ));
    }
  };
  const chipPointerCancel = (): void => {
    dragOriginRef.current = null;
    isDraggingRef.current = false;
    setPaneDrag(null);
  };
  // Esc = 드래그 취소·메뉴 닫기. 드래그 취소 후의 pointerup 은 origin 이 비어 no-op.
  useEffect(() => {
    if (!paneDrag && !chipMenu) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      chipPointerCancel();
      setChipMenu(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneDrag !== null, chipMenu !== null]);
  // 메뉴 밖 클릭 = 닫기. 칩 클릭 토글과 겹치지 않게 capture 단계가 아니라 bubble 로.
  useEffect(() => {
    if (!chipMenu) return undefined;
    const onDown = (e: PointerEvent): void => {
      if (!(e.target instanceof Element)) {
        setChipMenu(null);
        return;
      }
      // 메뉴 안 = 항목 클릭이 처리. 칩 위 = pointerup 의 토글이 처리(여기서 닫으면
      // 같은 칩 재클릭이 "닫힘→즉시 재열림" 으로 오동작).
      if (e.target.closest('[data-testid="pane-chip-menu"]')) return;
      if (e.target.closest('[data-testid^="pane-chip-"]')) return;
      setChipMenu(null);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [chipMenu]);
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
  // 자기 창의 등록만 고른다 — 남의 창 등록에는 같은 참조가 돌아와 재렌더가 안 난다.
  const maSeries = useMaSeriesRegistry((s) => scopeEntries(s.byScope, windowId));
  const dailyMaSeries = useDailyMaSeriesRegistry((s) => scopeEntries(s.byScope, windowId));
  // Registry subscription: re-renders on pane (un)mount so a toggled-on pane's
  // legend appears without waiting for a crosshair move.
  const legendPanes = usePaneLegendRegistry((s) => scopeEntries(s.byScope, windowId));
  // **지표 pref 구독 — 값은 안 쓰고 재렌더 신호로만 쓴다.**
  //
  // flag provider 는 비반응형 레지스트리에 있어(P1: SSE 틱마다 재렌더되는 것을 막는다)
  // 이 오버레이가 다시 렌더될 때 lazy 하게 읽힌다. 그런데 이 오버레이는 스토어 토글
  // (`useWindowIndicator`)만 구독하고 **chartPrefs 는 구독하지 않았다** — 그래서 지표
  // 설정을 바꾸면 선·마커는 즉시 갱신되는데 레전드만 **다음 상호작용(크로스헤어 이동·
  // 팬·토글)까지 옛 값**을 보였다. 실앱에서 매수 최대벽의 MA 필터를 끄면 선 3개가 바로
  // 나오는데 레전드는 비어 있는 모양으로 관측됐다.
  //
  // 전체 구독이 안전한 근거: chartPrefs 의 쓰기 경로는 **설정 UI 뿐**이다(설정 행 ·
  // 숫자 행 · 최대벽 개수 노브 — 실측 4곳). 즉 사용자 조작 빈도라 P1 이 막은 비용
  // (SSE 틱당 재렌더)을 되살리지 않는다. 반환값은 상태 객체당 memo 된 안정 참조라
  // (`prefsForScope` 의 WeakMap 캐시) 렌더마다 새로 구독되지도 않는다.
  void useScopedChartPrefs();

  // OHLC 레전드용 인덱싱 — 그려진(보이는) 봉 배열 + 가상초→index 맵(CandleTooltip 선례).
  // candles/axis 는 캔들 경로/segments 참조라 SSE 틱엔 재계산 안 됨. 팬/줌(axis 리베이스)·
  // 캔들 갱신 때만 새로.
  const drawnCandles = useMemo(
    () => (candles && axis ? candles.filter((c) => axis.contains(c.ts_ms)) : []),
    [candles, axis],
  );
  // 동기화 판정은 `CursorSyncCrosshair` 와 **같은 훅**을 쓴다 — 각자 하면 게이트가
  // 갈려 "선은 여기 있는데 숫자는 다른 봉" 이 된다.
  const syncResolution = useCursorSyncResolution({ candles: drawnCandles, timeframe, code });
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
      safeUnsubscribe(() => chart.unsubscribeCrosshairMove(onCrosshair));
      safeUnsubscribe(() => ts.unsubscribeVisibleLogicalRangeChange(schedule));
      ro?.disconnect();
    };
  }, [chart]);

  // ── runtime pane groups — drives both cell metadata and Y placement ──
  const groups = visibleGroups ?? paneGroupSpecsForTimeframe(timeframe, paneToggles, paneGroups);
  const specByPaneId = new Map<string, PaneSpecGroup[number]>();
  groups.forEach((g) => g.forEach((s) => {
    specByPaneId.set(s.name, s);
  }));

  // ── value extraction (read-only over the chart API) ────────────────────
  const seriesData = paramRef.current?.seriesData ?? null;

  // OHLC(항상 표시) — 우선순위 셋. 직전종가 대비 %는 buildCandleTooltip(순수, 툴팁과
  // 동일 규칙)에서.
  //
  //   1. 내 마우스가 올라간 봉(`param.time` = 가상초)
  //   2. **옆 창이 동기화로 그려 준 봉** — 아래 참조
  //   3. 최신 봉(폴백)
  //
  // 2가 없으면 동기화 창의 레전드가 **항상 최신 봉**을 보여준다. lwc 는
  // `setCrosshairPosition` 으로 그린 크로스헤어에 대해 `subscribeCrosshairMove` 를
  // 발화시키지 않아서(`CursorSyncCrosshair` 헤더의 실측) `param.time` 이 안 채워지고
  // 곧바로 3으로 떨어지기 때문이다. 실측(2026-08-21): 호버 창은 `종가 260,500`(그 봉)
  // 인데 동기화 창은 `종가 281,500`(오늘 봉)이라, 선은 같은 자리인데 숫자가 달라
  // "다른 차트" 로 보였다.
  let ohlc: LegendOhlcValues | null = null;
  if (drawnCandles.length > 0) {
    const t = typeof paramRef.current?.time === 'number' ? paramRef.current.time : null;
    const syncIdx = syncResolution.kind === 'hit' && axis
      ? vsecToIndex.get(axis.toVirtual(syncResolution.candle.ts_ms) / 1000)
      : undefined;
    const idx = (t !== null ? vsecToIndex.get(t) : undefined)
      ?? syncIdx
      ?? drawnCandles.length - 1;
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
    // 표시 게이트 — 행 생성은 위에서 전부 하고, 무엇을 그릴지는 여기서만 정한다.
    // 캔들 pane 의 OHLC·이동평균선(현재 타임프레임)에 더해, LEGEND_CELL_PANES 의
    // cells 행을 표시한다(거래량·총잔량 2026-08-04 · 프로그램 순매수 2026-08-18,
    // 둘 다 사용자 요청 — 이 pane 들은 다른 지표처럼 값 레전드를 갖는다).
    // LEGEND_FLAG_IDS 의 flag 행(당일 매도·매수 최대벽, 2026-08-22 사용자 요청)도 표시.
    // 계속 숨기는 것: 일봉 이동평균선(daily-ma) 행 — 차트의 일봉 MA 선 자체는
    // dailyMaSeriesRegistry 가 계속 그리고 값 표시 행만 뺀다. 화이트리스트 밖의 flag 행
    // (매물대·히트맵·단별잔량·신규거래원)과 나머지 cells pane(호가비·체결강도·투자자)도
    // 숨긴다(2026-07-22, 차트 밀집도). 지표 on/off 는 보조지표 패널이 담당.
  }).filter(
    (r) =>
      r.kind === 'ohlc' ||
      r.kind === 'ma' ||
      (r.kind === 'flag' && LEGEND_FLAG_IDS.has(r.id)) ||
      (r.kind === 'cells' && LEGEND_CELL_PANES.has(r.paneId)),
  );

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

  // 드래그 핸들러가 이벤트 시점에 읽는 지오메트리 미러 — 렌더가 쓰는 값과 같은
  // 소스라 드롭 존과 화면이 어긋날 수 없다. (렌더 중 ref 쓰기 대신 effect —
  // 폐기된 concurrent 렌더의 값이 남지 않게.)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    geometryRef.current = { paneTops, paneHeights, groups };
  });

  // pane 플롯 폭 = 우측 가격축 거터를 **뺀** 폭. 이 오버레이 컨테이너는 거터까지
  // 덮으므로(DayBoundaryOverlay 실측: 컨테이너 560.6px vs pane 498px, 거터 62.6px)
  // 그냥 우측 정렬하면 이동 버튼이 가격 라벨 위에 얹힌다. 0(첫 프레임·teardown)이면
  // 클램프를 포기하고 기존 inset 으로 폴백한다 — 아래 ResizeObserver/rangeChange
  // 재렌더가 다음 프레임에 보정한다.
  let plotWidth = 0;
  try {
    plotWidth = chart.timeScale().width();
  } catch {
    plotWidth = 0; // chart tearing down
  }

  // 왼쪽 축 거터('left' 모드) — lwc 는 축 컬럼 폭을 차트 전체가 나눠 가지므로 어느
  // pane 이든 보이는 왼쪽 스케일의 최대 폭이 곧 전 pane 의 좌측 거터다. 레전드를
  // 그만큼 밀지 않으면 칩이 왼쪽 축 눈금 위에 얹힌다. 스케일 API 가 없거나(구 lwc·
  // 테스트 스텁) 숨김이면 0 — 종전 배치 그대로.
  let leftAxisPx = 0;
  try {
    for (const p of panes) {
      const scale = (p as { priceScale?: (id: string) => { width?: () => number } | null })
        .priceScale?.('left');
      const w = scale?.width?.() ?? 0;
      if (Number.isFinite(w)) leftAxisPx = Math.max(leftAxisPx, w);
    }
  } catch {
    leftAxisPx = 0; // chart tearing down
  }
  const leftInset = leftAxisPx > 0 ? `calc(${leftAxisPx}px + ${LEGEND_INSET})` : LEGEND_INSET;

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
      {/* 마운트된 pane 그룹 순서로 순회 — 레전드 행이 없는 pane 도 래퍼를 받아
          ↑/↓ 순서 컨트롤을 노출한다. 캔들(idx 0)은 컨트롤 없이 행만 렌더.
          병합 pane 은 멤버들의 행을 그룹 순서대로 이어 붙인다. */}
      {groups.map((group, idx) => {
        const paneId = group[0].name;
        const groupKey = group.map((s) => s.name).join(',');
        // Pane not mounted yet (first frame after a toggle/reorder) → skip;
        // self-heals next tick once chart.panes() includes it.
        if (idx >= paneTops.length) return null;
        const paneRows = group.flatMap((member) => rowsByPane.get(member.name) ?? []);
        const showMoveControls = idx > 0; // 캔들은 고정
        if (paneRows.length === 0 && !showMoveControls) return null;
        // 컨트롤이 있는 pane 만 플롯 우측으로 클램프한다. 캔들은 폭을 그대로 둬서
        // OHLC 셀 드롭 컨테이너 쿼리(global.css `.legend-ohlc-*`)의 임계값을 건드리지
        // 않는다 — 그 쿼리는 캔들 pane 에만 적용되므로 다른 pane 이 좁아지는 것은 무해.
        const rightInset =
          showMoveControls && plotWidth > 0
            ? `calc(100% - ${leftAxisPx + plotWidth}px + ${LEGEND_INSET})`
            : LEGEND_INSET;
        return (
          <div
            key={groupKey}
            style={{
              position: 'absolute',
              top: `calc(${paneTops[idx]}px + ${LEGEND_INSET})`,
              left: leftInset,
              right: rightInset,
              display: 'flex',
              // row — 이동 컨트롤이 legend 행과 **같은 줄** 우측에 붙는다(2026-08-18).
              // 세로 스택이면 컨트롤이 legend 위 한 줄을 통째로 차지했다. 별도 절대배치
              // 대신 같은 flex 행에 두는 이유는 겹침 방지 — 절대배치였다면 좁은 pane 에서
              // legend 칩이 컨트롤 밑으로 파고들어 우측 끝 ✕ 가 **에러 없이** 안 눌린다
              // (둘 다 pointerEvents:auto 라 위에 있는 쪽이 이긴다).
              flexDirection: 'row',
              alignItems: 'flex-start',
              gap: 'var(--space-xs)',
              pointerEvents: 'none',
              // 자기 pane 안으로 가둔다. 캔들 pane 은 행이 6줄까지(MA·일봉MA·최대벽
              // 2종·매물대·히트맵) 쌓이는데, 창이 작아지면 그 높이가 pane 을 넘어
              // 차트 밖으로 흘러나가 잘렸다. 클램프하면 들어가는 행은 그대로 보이고
              // 넘치는 행만 자기 pane 경계에서 끊긴다 — 레전드는 원래 캔들 위에
              // 겹쳐 그리는 물건이라 pane 안에서의 클리핑은 계약 위반이 아니다.
              maxHeight: `calc(${paneHeights[idx]}px - ${LEGEND_INSET})`,
              overflow: 'hidden',
              // OHLC 셀 드롭(global.css 컨테이너 쿼리)의 기준 폭. 이 래퍼는 좌우
              // inset 절대배치라 폭이 내용과 무관 — inline-size 컨테이너로 안전하다
              // (내용이 폭을 정하는 inline-flex 요소에 걸면 폭이 무너진다).
              containerType: 'inline-size',
            }}
          >
            {/* 좌측 = 행 스택. 캔들 pane 은 MA·일봉MA·flag 가 여러 줄 쌓이므로 column
                을 유지한다. `minWidth: 0` 이 필수 — flex 자식의 기본 `min-width:auto`
                는 축소를 거부해서, 없으면 긴 레전드가 우측 컨트롤을 pane 밖으로 민다. */}
            {paneRows.length > 0 && (
              <div
                data-testid={`pane-legend-rows-${paneId}`}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: 'var(--space-2xs)',
                  minWidth: 0,
                }}
              >
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
            )}
            {/* 우측 = 칩(드래그 핸들) + 이동 컨트롤 클러스터. DOM 순서도 행 뒤로
                옮긴다(탭 순서 = 시각 순서). 칩이 이 기능의 핵심 진입점이다 —
                끌면 병합/이동, 클릭하면 메뉴(비드래그 폴백). */}
            {showMoveControls && (
              <span
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 'var(--space-2xs)',
                  // pane 우측 정렬 — 종전 PaneMoveControls 의 auto 마진을 클러스터가
                  // 물려받는다(legend 행 없는 pane 에서 유일 자식이어도 우측 유지).
                  marginLeft: 'auto',
                  flexShrink: 0,
                  pointerEvents: 'none',
                }}
              >
                {group.map((member) => (
                  <PaneChip
                    key={member.name}
                    paneId={member.name}
                    label={PANE_DISPLAY_NAME[member.name]}
                    axisBadge={(() => {
                      if (group.length <= 1) return null;
                      const mode = resolveAxisMode(paneGroupIds(group), paneAxisMode);
                      if (mode === 'shared') return null; // 한 축 — 소유 표시가 무의미
                      if (member === group[0]) return '축';
                      if (mode === 'left' && member === group[1]) return '좌축';
                      return null;
                    })()}
                    showRemove={group.length > 1}
                    onRemove={member.legendToggleKey
                      ? () => indicatorActions.setPanePrefForTimeframe(
                        timeframe, member.legendToggleKey!, false,
                      )
                      : null}
                    dimmed={paneDrag?.pane === member.name}
                    onPointerDown={chipPointerDown(
                      member.name, PANE_DISPLAY_NAME[member.name], group.length > 1,
                    )}
                    onPointerMove={chipPointerMove}
                    onPointerUp={chipPointerUp}
                    onPointerCancel={chipPointerCancel}
                  />
                ))}
                <PaneMoveControls
                  paneId={paneId}
                  // 이름은 `PANE_DISPLAY_NAME` 에서 온다 — `spec.legendTitle` 은 셀 앞
                  // 제목 접두사라 대부분의 pane 에 일부러 없고, 그걸 쓰면 aria-label 이
                  // `volume pane 위로 이동` 처럼 영문 paneId 로 샜다. 병합 pane 은
                  // 멤버 이름을 '+' 로 이어 그룹 전체가 움직임을 말한다.
                  label={group.map((s) => PANE_DISPLAY_NAME[s.name]).join(' + ')}
                  idx={idx}
                  mountedCount={Math.min(groups.length, paneTops.length)}
                  upNeighbor={idx - 1 >= 0 ? groups[idx - 1][0].name : null}
                  downNeighbor={idx + 1 < groups.length ? groups[idx + 1][0].name : null}
                  paneGroups={paneGroups}
                />
              </span>
            )}
          </div>
        );
      })}

      {/* ── 병합 드래그 비주얼: pane 틴트+배너 / 경계 삽입선 / 고스트 칩 ── */}
      {paneDrag && paneDrag.target?.kind === 'merge' && (() => {
        const t = paneDrag.target;
        const targetGroup = groups[t.paneIndex];
        if (!targetGroup || t.paneIndex >= paneTops.length) return null;
        const hint = mergeDropHint(paneDrag.pane, paneGroupIds(targetGroup));
        return (
          <div
            data-testid="pane-drop-merge"
            style={{
              position: 'absolute',
              top: paneTops[t.paneIndex] + 2,
              height: Math.max(0, paneHeights[t.paneIndex] - 4),
              left: 2,
              right: 2,
              zIndex: 6,
              pointerEvents: 'none',
              background: 'color-mix(in srgb, var(--accent) 8%, transparent)',
              border: '1.5px dashed color-mix(in srgb, var(--accent) 70%, transparent)',
              borderRadius: 'var(--radius-md)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                background: 'var(--bg-card)',
                border: `1px solid ${hint.warning ? 'var(--warn)' : 'var(--accent)'}`,
                borderRadius: 'var(--radius-md)',
                padding: 'var(--space-2xs) var(--space-sm)',
                textAlign: 'center',
                fontSize: 'var(--text-xs)',
                color: 'var(--fg)',
                whiteSpace: 'nowrap',
              }}
            >
              {hint.title}
              <span
                style={{
                  display: 'block',
                  color: hint.warning ? 'var(--warn)' : 'var(--fg-dim)',
                  fontSize: 'var(--text-2xs)',
                }}
              >
                {hint.hint}
              </span>
            </div>
          </div>
        );
      })()}
      {paneDrag && paneDrag.target?.kind === 'boundary' && (
        <div
          data-testid="pane-drop-boundary"
          style={{
            position: 'absolute',
            top: paneDrag.target.yPx - 1.5,
            left: 2,
            right: 2,
            height: 3,
            background: 'var(--accent)',
            borderRadius: 2,
            zIndex: 6,
            pointerEvents: 'none',
          }}
        >
          <span
            style={{
              position: 'absolute',
              top: -20,
              left: '50%',
              transform: 'translateX(-50%)',
              background: 'var(--accent)',
              color: 'var(--bg)',
              fontSize: 'var(--text-2xs)',
              fontWeight: 700,
              borderRadius: 'var(--radius-sm)',
              padding: '1px var(--space-xs)',
              whiteSpace: 'nowrap',
            }}
          >
            {boundaryDropLabel(paneDrag.fromMerged)}
          </span>
        </div>
      )}
      {paneDrag && (
        <span
          data-testid="pane-drag-ghost"
          style={{
            ...boxStyle,
            position: 'absolute',
            left: paneDrag.x + 10,
            top: paneDrag.y + 8,
            zIndex: 7,
            pointerEvents: 'none',
            gap: 'var(--space-2xs)',
            color: 'var(--fg)',
            background: 'var(--bg-card)',
            border: '1px solid var(--accent)',
            boxShadow: '0 6px 18px rgba(0, 0, 0, 0.4)',
          }}
        >
          <span aria-hidden="true" style={{ color: 'var(--fg-dimmer)', display: 'inline-flex' }}>
            <GripGlyph />
          </span>
          {paneDrag.label}
        </span>
      )}

      {/* ── 칩 클릭 메뉴 — 드래그 없이 병합/분리하는 폴백 경로 ── */}
      {chipMenu && (() => {
        const gi = groups.findIndex((g) => g.some((s) => s.name === chipMenu.pane));
        if (gi < 0) return null;
        const merged = groups[gi].length > 1;
        const ownIds = paneGroupIds(groups[gi]);
        const axisMode = resolveAxisMode(ownIds, paneAxisMode);
        const secondName = groups[gi].length > 1 ? PANE_DISPLAY_NAME[groups[gi][1].name] : null;
        // 위 이웃이 candle(그룹 0)이면 병합 불가 — candle 은 타겟이 아니다.
        const upGroup = gi - 1 >= 1 ? groups[gi - 1] : null;
        const downGroup = gi + 1 < groups.length ? groups[gi + 1] : null;
        const commit = (next: PaneGroups): void => {
          indicatorActions.setPaneGroups(next);
          setChipMenu(null);
        };
        const itemStyle: CSSProperties = {
          display: 'block',
          width: '100%',
          textAlign: 'left',
          padding: 'var(--space-2xs) var(--space-sm)',
          border: 'none',
          background: 'none',
          color: 'var(--fg)',
          fontSize: 'var(--text-xs)',
          fontFamily: 'inherit',
          borderRadius: 'var(--radius-sm)',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        };
        const hoverOn = (e: React.MouseEvent<HTMLButtonElement>): void => {
          e.currentTarget.style.background = 'var(--bg-input-hover)';
        };
        const hoverOff = (e: React.MouseEvent<HTMLButtonElement>): void => {
          e.currentTarget.style.background = 'none';
        };
        return (
          <div
            data-testid="pane-chip-menu"
            style={{
              position: 'absolute',
              left: chipMenu.x,
              top: chipMenu.y + 6,
              transform: 'translateX(-100%)',
              zIndex: 8,
              pointerEvents: 'auto',
              background: 'var(--bg-card)',
              border: '1px solid var(--border-strong)',
              borderRadius: 'var(--radius-md)',
              boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)',
              padding: 'var(--space-2xs)',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {/* y축 모드 — 현재 모드를 제외한 나머지 둘을 항목으로 노출한다.
                공유 = 전원이 오른쪽 축 하나(오토스케일 합산 — 단위가 다르면 한쪽이
                눌린다), 분리 = 멤버별 격리 스케일(기본), 왼쪽 축 = 둘째 멤버 눈금을
                왼쪽에(차트 전체에 왼쪽 거터가 생기는 비용이 있어 opt-in).
                오버라이드는 구성 키에 저장돼, 멤버가 바뀌면 기본값으로 리셋된다. */}
            {merged && axisMode !== 'shared' && (
              <button
                type="button"
                data-testid="pane-menu-axis-shared"
                style={itemStyle}
                onMouseEnter={hoverOn}
                onMouseLeave={hoverOff}
                onClick={() => {
                  indicatorActions.setPaneAxisMode(ownIds, 'shared');
                  setChipMenu(null);
                }}
              >
                y축 공유 (한 스케일)
              </button>
            )}
            {merged && axisMode !== 'isolated' && (
              <button
                type="button"
                data-testid="pane-menu-axis-isolated"
                style={itemStyle}
                onMouseEnter={hoverOn}
                onMouseLeave={hoverOff}
                onClick={() => {
                  indicatorActions.setPaneAxisMode(ownIds, 'isolated');
                  setChipMenu(null);
                }}
              >
                {axisMode === 'left' ? '왼쪽 축 숨기기 (멤버별 스케일)' : 'y축 분리 (멤버별 스케일)'}
              </button>
            )}
            {merged && axisMode !== 'left' && secondName !== null && (
              <button
                type="button"
                data-testid="pane-menu-axis-left"
                style={itemStyle}
                onMouseEnter={hoverOn}
                onMouseLeave={hoverOff}
                onClick={() => {
                  indicatorActions.setPaneAxisMode(ownIds, 'left');
                  setChipMenu(null);
                }}
              >
                {`『${secondName}』 왼쪽 축에 표시`}
              </button>
            )}
            {merged && (
              <button
                type="button"
                data-testid="pane-menu-split"
                style={itemStyle}
                onMouseEnter={hoverOn}
                onMouseLeave={hoverOff}
                onClick={() => commit(extractPaneToBoundary(
                  paneGroups, chipMenu.pane, paneGroupIndexOf(paneGroups, chipMenu.pane) + 1,
                ))}
              >
                {`『${PANE_DISPLAY_NAME[chipMenu.pane]}』 새 pane 으로 분리`}
              </button>
            )}
            {upGroup && (
              <button
                type="button"
                data-testid="pane-menu-merge-up"
                style={itemStyle}
                onMouseEnter={hoverOn}
                onMouseLeave={hoverOff}
                onClick={() => commit(mergePaneIntoGroup(paneGroups, chipMenu.pane, upGroup[0].name))}
              >
                {`위 pane(『${PANE_DISPLAY_NAME[upGroup[0].name]}』)과 합치기`}
              </button>
            )}
            {downGroup && (
              <button
                type="button"
                data-testid="pane-menu-merge-down"
                style={itemStyle}
                onMouseEnter={hoverOn}
                onMouseLeave={hoverOff}
                onClick={() => commit(mergePaneIntoGroup(paneGroups, chipMenu.pane, downGroup[0].name))}
              >
                {`아래 pane(『${PANE_DISPLAY_NAME[downGroup[0].name]}』)과 합치기`}
              </button>
            )}
          </div>
        );
      })()}
    </div>
  );
}

// P1: memo로 부모(LiveChartRoot)의 SSE 호가 틱 재렌더를 차단 — props(chart/timeframe/
// paneToggles/dataEpoch)가 동일하면 재렌더 안 함. 크로스헤어/스토어/레지스트리 변경은
// 내부 구독/셀렉터가 재렌더하므로 memo와 무관하게 동작한다. 호가-경로 pane의 커서-idle
// latest가 캔들 epoch 주기로만 신선화되는 것은 의도된 트레이드오프 — dataEpoch prop
// JSDoc 참조.
export default memo(PaneLegendOverlay);
