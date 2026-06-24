import { memo, useEffect, useReducer, useRef, type CSSProperties } from 'react';
import type { IChartApi, ITimeScaleApi, Time } from 'lightweight-charts';
import type { RangeBundle } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import type { PaneId } from '../chart/drawing/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { LiveTimeframe } from '../state/livePage';
import { useActivePrefs } from '../state/chartPrefs';
import { resolveTokens } from '../util/tokens';
import { computeVisibleExtremes } from './visibleExtremes';
import { formatExtremeLabel } from './formatExtremeLabel';

// DESIGN.md 성역: 상승=빨강 / 하락=파랑. 고가 라벨=빨강, 저가 라벨=파랑. candle.ts 와 동일 토큰.
const TOKENS = resolveTokens({
  up: ['--price-up', '#DC2626'],
  down: ['--price-down', '#2563EB'],
});

type Props = {
  chart: IChartApi;
  /** 캔들 경로 bundle(cb) — 현재가 = candles.at(-1).close. */
  bundle: RangeBundle;
  axis: VirtualAxis;
  paneSeries: PaneSeriesMap;
  timeframe: LiveTimeframe;
  /** Canvas-based wall indicator labels already occupying these y lines. High/low labels yield. */
  avoidLabelYLines?: readonly number[];
};

const dotStyle = (color: string): CSSProperties => ({
  position: 'absolute',
  width: 6,
  height: 6,
  borderRadius: '50%',
  background: color,
  transform: 'translate(-50%, -50%)',
});

type ExtremeLabelPlace = 'above' | 'below';

export type ExtremeLabelPlacement = {
  x: number;
  y: number;
  place: ExtremeLabelPlace;
};

const LABEL_EDGE_PAD_PX = 6;
const LABEL_DOT_GAP_PX = 8;
const LABEL_HEIGHT_PX = 16;
const LABEL_CHAR_WIDTH_PX = 6.6;
const LABEL_AVOID_GAP_PX = 2;
const WALL_LABEL_GAP_PX = 3;
const WALL_LABEL_FONT_PX = 11;
const WALL_LABEL_BOX_Y_PAD_PX = 1;

function estimateLabelWidth(text: string): number {
  return text.length * LABEL_CHAR_WIDTH_PX + 8;
}

type VerticalBox = {
  top: number;
  bottom: number;
};

function highLowLabelBox(anchorY: number, place: ExtremeLabelPlace): VerticalBox {
  return place === 'above'
    ? { top: anchorY - LABEL_DOT_GAP_PX - LABEL_HEIGHT_PX, bottom: anchorY - LABEL_DOT_GAP_PX }
    : { top: anchorY + LABEL_DOT_GAP_PX, bottom: anchorY + LABEL_DOT_GAP_PX + LABEL_HEIGHT_PX };
}

function wallLabelBoxFromLineY(lineY: number): VerticalBox {
  const baselineY = lineY - WALL_LABEL_GAP_PX;
  return {
    top: baselineY - WALL_LABEL_FONT_PX - WALL_LABEL_BOX_Y_PAD_PX,
    bottom: baselineY + WALL_LABEL_BOX_Y_PAD_PX,
  };
}

function verticalBoxesOverlap(a: VerticalBox, b: VerticalBox): boolean {
  return a.top < b.bottom && b.top < a.bottom;
}

export function placeExtremeLabel(
  preferred: ExtremeLabelPlace,
  x: number,
  y: number,
  text: string,
  paneWidth: number,
  paneHeight: number,
  avoidYLines: readonly number[] = [],
): ExtremeLabelPlacement {
  if (paneWidth <= 0 || paneHeight <= 0) return { x, y, place: preferred };
  const labelWidth = estimateLabelWidth(text);
  const halfWidth = labelWidth / 2;
  const minX = LABEL_EDGE_PAD_PX + halfWidth;
  const maxX = Math.max(minX, paneWidth - LABEL_EDGE_PAD_PX - halfWidth);
  const placedX = Math.min(maxX, Math.max(minX, x));
  const roomAbove = y - LABEL_DOT_GAP_PX - LABEL_HEIGHT_PX >= LABEL_EDGE_PAD_PX;
  const roomBelow = y + LABEL_DOT_GAP_PX + LABEL_HEIGHT_PX <= paneHeight - LABEL_EDGE_PAD_PX;
  let place = preferred;
  if (preferred === 'above' && !roomAbove && roomBelow) place = 'below';
  if (preferred === 'below' && !roomBelow && roomAbove) place = 'above';
  let placedY = Math.min(paneHeight - LABEL_EDGE_PAD_PX, Math.max(LABEL_EDGE_PAD_PX, y));
  if (avoidYLines.length > 0) {
    const minY = LABEL_EDGE_PAD_PX;
    const maxY = paneHeight - LABEL_EDGE_PAD_PX;
    const direction = place === 'above' ? -1 : 1;
    const avoidBoxes = avoidYLines.filter(Number.isFinite).map(wallLabelBoxFromLineY);
    const conflicts = (candidate: number) => {
      const candidateBox = highLowLabelBox(candidate, place);
      return avoidBoxes.some((box) => verticalBoxesOverlap(candidateBox, box));
    };
    const pushAway = (startY: number, pushDirection: 1 | -1): number => {
      let candidate = startY;
      const sorted = avoidBoxes
        .sort((a, b) => (
          pushDirection > 0 ? a.top - b.top : b.bottom - a.bottom
        ));
      for (const box of sorted) {
        if (verticalBoxesOverlap(highLowLabelBox(candidate, place), box)) {
          candidate = place === 'above'
            ? (
              pushDirection < 0
                ? box.top - LABEL_AVOID_GAP_PX + LABEL_DOT_GAP_PX
                : box.bottom + LABEL_AVOID_GAP_PX + LABEL_DOT_GAP_PX + LABEL_HEIGHT_PX
            )
            : (
              pushDirection > 0
                ? box.bottom + LABEL_AVOID_GAP_PX - LABEL_DOT_GAP_PX
                : box.top - LABEL_AVOID_GAP_PX - LABEL_DOT_GAP_PX - LABEL_HEIGHT_PX
            );
        }
      }
      return Math.min(maxY, Math.max(minY, candidate));
    };
    const preferredY = pushAway(placedY, direction);
    placedY = conflicts(preferredY) ? pushAway(placedY, direction === 1 ? -1 : 1) : preferredY;
  }
  return { x: placedX, y: placedY, place };
}

const labelStyle = (place: ExtremeLabelPlace, color: string): CSSProperties => ({
  position: 'absolute',
  transform: place === 'above'
    ? `translate(-50%, calc(-100% - ${LABEL_DOT_GAP_PX}px))`
    : `translate(-50%, ${LABEL_DOT_GAP_PX}px)`,
  color,
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--text-xs)',
  lineHeight: 1.2,
  whiteSpace: 'nowrap',
  background: 'rgba(11, 15, 26, 0.76)',
  borderRadius: 2,
  padding: '1px 4px',
  boxShadow: '0 0 0 1px rgba(11, 15, 26, 0.58)',
});

/** 가시 시간범위(가상초 {from,to}). 초기 마운트엔 null, 차트 teardown 중엔 throw → null. */
function readVisibleRange(ts: ITimeScaleApi<Time>): { from: number; to: number } | null {
  try {
    const r = ts.getVisibleRange();
    return r ? { from: Number(r.from), to: Number(r.to) } : null;
  } catch {
    return null;
  }
}

/**
 * /live 캔들 pane 의 **고저 극값 라벨**(CONTEXT.md `High/Low Extreme Labels`) 오버레이.
 * 현재 보이는 뷰포트의 최고가 봉(빨강)·최저가 봉(파랑)에 작은 점 + `<가격>원 (<±극값 대비율>%, <시각>)`
 * 라벨을 그린다. PaneLegendOverlay 형제 패턴: `subscribeVisibleLogicalRangeChange` 를 rAF throttle
 * 구독해 팬/줌 시 재계산하고, 차트 API 는 read-only 로 읽는다. PaneSpec series-marker 가 아닌
 * DOM 오버레이인 이유: marker seam 은 데이터 cadence(팬/줌 무반응)라 이 기능엔 맞지 않음(그릴링).
 */
function HighLowAnnotationOverlay({ chart, bundle, axis, paneSeries, timeframe, avoidLabelYLines = [] }: Props) {
  const enabled = useActivePrefs((p) => p.highLowLabelsEnabled);
  const containerRef = useRef<HTMLDivElement>(null);
  const [, tick] = useReducer((n: number) => n + 1, 0);

  // 재계산 트리거: 팬/줌(visible range 변경) + 리사이즈(ResizeObserver). rAF 1틱으로
  // coalesce 후 재렌더. ResizeObserver 가 필수인 이유(PaneLegendOverlay 동일): 패널
  // 리사이즈는 픽셀 좌표를 바꾸지만 visible *logical* range(인덱스)는 그대로일 수 있어
  // range 구독이 안 깨어남 → 라벨이 옛 픽셀에 고정됨. RO 의 initial observe 콜백은
  // 첫 레이아웃 후(초기 getVisibleRange null 이던 프레임) 라벨 등장도 self-heal 한다.
  // 토글 off면 미구독.
  useEffect(() => {
    if (!enabled) return;
    const ts = chart.timeScale();
    let raf = 0;
    const schedule = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        tick();
      });
    };
    ts.subscribeVisibleLogicalRangeChange(schedule);
    const ro =
      containerRef.current && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(schedule)
        : null;
    if (ro && containerRef.current) ro.observe(containerRef.current);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ts.unsubscribeVisibleLogicalRangeChange(schedule);
      ro?.disconnect();
    };
  }, [chart, enabled]);

  if (!enabled) return null;

  // 컨테이너는 enabled면 항상 렌더(빈 상태 포함) — ResizeObserver 가 관측할 DOM 노드를
  // 보장해 리사이즈/초기 레이아웃 self-heal 경로를 유지한다. 라벨만 조건부.
  const series = paneSeries.get('candle' as PaneId);
  const paneRect = containerRef.current?.getBoundingClientRect();
  const paneWidth = paneRect?.width ?? 0;
  const paneHeight = paneRect?.height ?? 0;
  const ts = chart.timeScale();
  const range = readVisibleRange(ts);
  // 기준가는 computeVisibleExtremes 가 가시 범위의 우측 끝 캔들 close에서 내부 산출한다
  // (전체 마지막 캔들이 아님 — 팬하면 기준이 바뀐다).
  const ex = series ? computeVisibleExtremes(bundle.candles, axis, range) : null;

  const items = (ex
    ? [
        { kind: 'high' as const, e: ex.high, color: TOKENS.up, place: 'above' as const },
        { kind: 'low' as const, e: ex.low, color: TOKENS.down, place: 'below' as const },
      ]
    : []
  ).map((d) => {
    if (!series) return null; // ex 가 있으면 series 는 truthy(위에서 보장) — TS 내로잉용.
    // 좌표 투영. null = 우측 빈 띠/범위 밖 → skip. try/catch = 차트 teardown 레이스에서
    // timeToCoordinate/priceToCoordinate 가 "Object is disposed" throw 시 안전 skip(다음
    // 프레임 self-heal) — RangeSeriesPane.removeSeries 가드와 동일 정신.
    let xc: ReturnType<typeof ts.timeToCoordinate>;
    let yc: ReturnType<typeof series.priceToCoordinate>;
    try {
      xc = ts.timeToCoordinate(d.e.virtualSec as Time);
      yc = series.priceToCoordinate(d.e.price);
    } catch {
      return null;
    }
    if (xc == null || yc == null) return null;
    return {
      ...d,
      x: Number(xc),
      y: Number(yc),
      text: formatExtremeLabel(d.e.price, d.e.pct, d.e.tsMs, timeframe),
    };
  });

  return (
    <div
      ref={containerRef}
      data-testid="highlow-overlay"
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 4 }}
    >
      {items.map(
        (it) => {
          if (!it) return null;
          const label = placeExtremeLabel(it.place, it.x, it.y, it.text, paneWidth, paneHeight, avoidLabelYLines);
          return (
            <div key={it.kind}>
              <span aria-hidden="true" style={{ ...dotStyle(it.color), left: it.x, top: it.y }} />
              <div
                data-testid={`highlow-label-${it.kind}`}
                style={{ ...labelStyle(label.place, it.color), left: label.x, top: label.y }}
              >
                {it.text}
              </div>
            </div>
          );
        },
      )}
    </div>
  );
}

// memo: 캔들 경로(cb·안정) props 라 SSE 호가 틱엔 재렌더되지 않음(PaneLegendOverlay 선례).
export default memo(HighLowAnnotationOverlay);
