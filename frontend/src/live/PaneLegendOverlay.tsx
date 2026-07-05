// Pane Legend — a TradingView-style legend pinned to each chart pane's
// top-left: indicator label + color swatch + the value under the cursor
// (latest point when the cursor is away), with ✕ (turn the indicator off) and
// an eye (hide the MA lines) control.
//
// Value source is the SAME series the chart draws — read back through
// `param.seriesData` (cursor) / `series.data()` (latest), never recomputed.
// MA slot series come from the global `maSeriesRegistry`; each non-candle
// pane's primary series comes from the `paneSeries` registry threaded down by
// LiveChartRoot. Pane Y is the runtime `paneSpecsForTimeframe` order summed
// over `chart.panes()[i].getHeight()` — NOT `chartCoordinates.paneTopY`, whose
// static PANE_SPECS map returns 0 for the runtime-appended investor panes.
//
// See docs/superpowers/specs/2026-05-31-chart-indicator-legend-design.md.

import { memo, useEffect, useReducer, useRef, type CSSProperties } from 'react';
import type { IChartApi, MouseEventParams } from 'lightweight-charts';
import { useLivePageStore, type LiveTimeframe } from '../state/livePage';
import { useMaSeriesRegistry } from './indicators/maSeriesRegistry';
import { paneSpecsForTimeframe, type PaneToggles } from './paneSpecsForTimeframe';
import { buildLegendRows, readSeriesValue, type LegendRow } from './legendRows';
import { formatKoreanInt } from '../util/koreanNumber';
import type { PaneId } from '../chart/drawing/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';

type Props = {
  chart: IChartApi;
  timeframe: LiveTimeframe;
  paneSeries: PaneSeriesMap;
  paneToggles: PaneToggles;
  /** P1: 캔들-경로 데이터 신선화 토큰. /live가 SSE 호가 틱마다 부모(LiveChartRoot)를
   *  재렌더하지만 이 레전드의 값(MA/거래량/투자자 = 캔들 경로)은 그때 안 바뀐다.
   *  memo + 이 prop으로 호가 틱 재렌더는 차단하고, 캔들 갱신(chartBundle 식별자 변경)
   *  때만 latest 값을 신선화한다. /live는 chartBundle ref를 그대로 넘긴다(호가 틱엔
   *  안정, 캔들 갱신 땐 새 ref). 본문에서 읽지 않고 memo 얕은 비교 신호로만 쓴다
   *  (크로스헤어/스토어 재렌더는 내부 구독이라 memo와 무관). */
  dataEpoch?: unknown;
};

// Worst-case width `-9,999,999` (~11 glyphs) reserved so the value cell never
// reflows as the cursor sweeps across magnitudes (DESIGN.md tabular-nums).
const VALUE_MIN_WIDTH = '12ch';
const LEGEND_INSET = 'var(--space-xs)';

const boxStyle: CSSProperties = {
  position: 'absolute',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--space-xs)',
  // Opaque surface — translucent has no DESIGN.md token, and a legend over
  // saturated candles needs guaranteed contrast (SourceChip precedent).
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  padding: 'var(--space-2xs) var(--space-sm)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--text-xs)',
  lineHeight: 1.4,
  whiteSpace: 'nowrap',
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

function ValueCell({ value }: { value: number | null }) {
  return (
    <span
      style={{
        minWidth: VALUE_MIN_WIDTH,
        textAlign: 'right',
        color: 'var(--fg)',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {value == null ? '—' : formatKoreanInt(value)}
    </span>
  );
}

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

function MaLegendRow({ row }: { row: Extract<LegendRow, { paneId: 'candle' }> }) {
  const setHidden = useLivePageStore((s) => s.setMovingAverageHidden);
  const setEnabled = useLivePageStore((s) => s.setMovingAverageEnabled);
  return (
    <>
      <span style={{ color: 'var(--fg-dim)' }}>이동평균선</span>
      {row.mas.map((m) => (
        <span
          key={m.id}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2xs)' }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 8,
              height: 8,
              borderRadius: 'var(--radius-sm)',
              background: m.color,
              display: 'inline-block',
            }}
          />
          <span style={{ color: 'var(--fg-dim)' }}>{m.period}</span>
          <ValueCell value={m.value} />
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

function SingleLegendRow({
  row,
  timeframe,
}: {
  row: Exclude<LegendRow, { paneId: 'candle' }>;
  timeframe: LiveTimeframe;
}) {
  const setPanePrefForTimeframe = useLivePageStore((s) => s.setPanePrefForTimeframe);
  const turnOff = () => {
    switch (row.paneId) {
      case 'volume':
        setPanePrefForTimeframe(timeframe, 'volumeEnabled', false);
        break;
      case 'investor-foreign':
        setPanePrefForTimeframe(timeframe, 'foreignNetEnabled', false);
        break;
      case 'investor-institution':
        setPanePrefForTimeframe(timeframe, 'institutionNetEnabled', false);
        break;
      default: {
        const _exhaustive: never = row;
        void _exhaustive;
      }
    }
  };
  return (
    <>
      <span style={{ color: 'var(--fg-dim)' }}>{row.label}</span>
      <ValueCell value={row.value} />
      <HoverIcon label={`${row.label} 지표 끄기`} restColor="var(--fg-dimmer)" onClick={turnOff}>
        <CloseGlyph />
      </HoverIcon>
    </>
  );
}

function PaneLegendOverlay({ chart, timeframe, paneSeries, paneToggles }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Last crosshair param (null = cursor away → latest-fallback). Mutated by the
  // subscription, read during render; a tick (below) re-renders after each
  // mutation so the read stays consistent with React state.
  const paramRef = useRef<MouseEventParams | null>(null);
  const [, tick] = useReducer((n: number) => n + 1, 0);

  const movingAverages = useLivePageStore((s) => s.movingAverages);
  const movingAverageEnabled = useLivePageStore((s) => s.movingAverageEnabled);
  const movingAverageHidden = useLivePageStore((s) => s.movingAverageHidden);
  const maSeries = useMaSeriesRegistry((s) => s.series);

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

  // ── value extraction (read-only over the chart API) ────────────────────
  const seriesData = paramRef.current?.seriesData ?? null;
  const maValues = new Map<string, number>();
  for (const [id, series] of maSeries) {
    const v = readSeriesValue(series, seriesData);
    if (v !== null) maValues.set(id, v);
  }
  const valueFor = (paneId: PaneId) => readSeriesValue(paneSeries.get(paneId), seriesData);

  const rows = buildLegendRows({
    timeframe,
    movingAverages,
    movingAverageEnabled,
    movingAverageHidden,
    maValues,
    volumeEnabled: paneToggles.volumeEnabled !== false,
    volumeValue: valueFor('volume'),
    foreignNetEnabled: paneToggles.foreignNet,
    foreignValue: valueFor('investor-foreign'),
    institutionNetEnabled: paneToggles.institutionNet,
    institutionValue: valueFor('investor-institution'),
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
  const specs = paneSpecsForTimeframe(timeframe, paneToggles);
  const indexByPaneId = new Map<string, number>();
  specs.forEach((s, i) => indexByPaneId.set(s.name, i));

  return (
    <div
      ref={containerRef}
      data-testid="pane-legend-overlay"
      // pointer-events:none keeps the crosshair alive under the legend; only
      // the icon buttons re-enable hits (iconBtnStyle).
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 4 }}
    >
      {rows.map((row) => {
        const idx = indexByPaneId.get(row.paneId);
        // Pane not mounted yet (first frame after a toggle) → skip; self-heals
        // next tick once chart.panes() includes it.
        if (idx == null || idx >= paneTops.length) return null;
        return (
          <div
            key={row.paneId}
            style={{
              ...boxStyle,
              top: `calc(${paneTops[idx]}px + ${LEGEND_INSET})`,
              left: LEGEND_INSET,
            }}
          >
            {row.paneId === 'candle' ? (
              <MaLegendRow row={row} />
            ) : (
              <SingleLegendRow row={row} timeframe={timeframe} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// P1: memo로 부모(LiveChartRoot)의 SSE 호가 틱 재렌더를 차단 — props(chart/timeframe/
// paneSeries/dataEpoch)가 동일하면 재렌더 안 함. 호가 틱엔 이 넷이 모두 안 바뀌므로
// 틱당 series.data() O(N) 리드백이 사라진다. 캔들 갱신 땐 dataEpoch가 바뀌어 신선화되고,
// 크로스헤어/스토어 변경은 내부 구독/셀렉터가 재렌더하므로 memo와 무관하게 동작한다.
export default memo(PaneLegendOverlay);
