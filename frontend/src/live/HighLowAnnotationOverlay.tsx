import { memo, useEffect, useReducer, useRef, type CSSProperties } from 'react';
import type { IChartApi, ITimeScaleApi, Time } from 'lightweight-charts';
import type { RangeBundle } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import type { PaneId } from '../chart/drawing/types';
import type { PaneSeriesMap } from '../chart/drawing/chartCoordinates';
import type { LiveTimeframe } from '../state/livePage';
import { useActivePrefs } from '../state/chartPrefs';
import { resolveTokensThemed } from '../util/tokens';
import { computeVisibleExtremes } from './visibleExtremes';
import { formatExtremeLabel } from './formatExtremeLabel';

// DESIGN.md 성역: 상승=빨강 / 하락=파랑. 고가 라벨=빨강, 저가 라벨=파랑. candle.ts 와 동일 토큰.
// 렌더에서 지연 해석 — 테마(Obsidian/Ledger) 전환 시 라벨 색이 따라온다.
const TOKEN_SPEC = {
  up: ['--price-up', '#F04452'],
  down: ['--price-down', '#3485FA'],
} as const;

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
  // 배경색 링 — 같은 방향색 캔들(적/청) 위에서도 극값 점이 파묻히지 않게 분리.
  boxShadow: '0 0 0 1.5px var(--bg-card)',
  transform: 'translate(-50%, -50%)',
});

type ExtremeLabelPlace = 'above' | 'below';

export type ExtremeLabelPlacement = {
  x: number;
  y: number;
  place: ExtremeLabelPlace;
};

const LABEL_EDGE_PAD_PX = 6;
const LABEL_HEIGHT_PX = 16;
const LEADER_MIN_HEIGHT_PX = 3;
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

// 가장자리 고정 라벨 박스. anchorY 는 라벨의 pane-가장자리 쪽 모서리:
// 'above'(고가)=상단 가장자리에서 아래로, 'below'(저가)=하단 가장자리에서 위로.
function highLowLabelBox(anchorY: number, place: ExtremeLabelPlace): VerticalBox {
  return place === 'above'
    ? { top: anchorY, bottom: anchorY + LABEL_HEIGHT_PX }
    : { top: anchorY - LABEL_HEIGHT_PX, bottom: anchorY };
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
  // x: dot(극값 봉) x 를 유지하되 라벨 폭 절반이 pane 좌우 가장자리를 넘지 않게 클램프.
  const labelWidth = estimateLabelWidth(text);
  const halfWidth = labelWidth / 2;
  const minX = LABEL_EDGE_PAD_PX + halfWidth;
  const maxX = Math.max(minX, paneWidth - LABEL_EDGE_PAD_PX - halfWidth);
  const placedX = Math.min(maxX, Math.max(minX, x));

  // 라벨은 가격이 아니라 pane 가장자리에 고정한다: 고가('above')=상단, 저가('below')=하단.
  // 반전 없음 — dot 은 극값 가격 위치에 남고 렌더 단 리더선이 dot↔라벨을 잇는다.
  const place = preferred;
  const minY = LABEL_EDGE_PAD_PX;
  const maxY = paneHeight - LABEL_EDGE_PAD_PX;
  let anchorY = place === 'above' ? minY : maxY;

  // wall(Ask/Bid Peak 등) 라벨과 겹치면 pane 안쪽으로 양보: 상단 라벨은 아래로,
  // 하단 라벨은 위로 민다(가장자리 고정의 역방향 push). 가장자리 근처 wall 만 실효.
  if (avoidYLines.length > 0) {
    const avoidBoxes = avoidYLines
      .filter(Number.isFinite)
      .map(wallLabelBoxFromLineY)
      .sort((a, b) => (place === 'above' ? a.top - b.top : b.bottom - a.bottom));
    for (const box of avoidBoxes) {
      if (verticalBoxesOverlap(highLowLabelBox(anchorY, place), box)) {
        anchorY = place === 'above'
          ? box.bottom + LABEL_AVOID_GAP_PX
          : box.top - LABEL_AVOID_GAP_PX;
      }
    }
  }

  // 라벨 박스 전체가 pane 안에 머물도록 앵커 클램프.
  const anchorMin = place === 'above' ? minY : minY + LABEL_HEIGHT_PX;
  const anchorMax = place === 'above' ? maxY - LABEL_HEIGHT_PX : maxY;
  const placedY = Math.min(anchorMax, Math.max(anchorMin, anchorY));
  return { x: placedX, y: placedY, place };
}

const labelStyle = (place: ExtremeLabelPlace, color: string): CSSProperties => ({
  position: 'absolute',
  // 앵커(top:label.y)는 라벨의 pane-가장자리 쪽 모서리. above=앵커가 라벨 top → 아래로 렌더,
  // below=앵커가 라벨 bottom → 위로 렌더.
  transform: place === 'above'
    ? 'translate(-50%, 0)'
    : 'translate(-50%, -100%)',
  color,
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--text-xs)',
  fontWeight: 600,
  lineHeight: 1.2,
  whiteSpace: 'nowrap',
  // 테마 표면(불투명) + 강한 테두리 링 + 옅은 드롭섀도 — 하드코딩 다크 반투명이던
  // 것을 토큰화해 Ledger 라이트에서도 방향색 텍스트가 캔들 위에서 또렷하게 뜬다.
  // 불투명이라 뒤 캔들이 비쳐 대비를 깎던 문제 해소.
  background: 'var(--bg-card)',
  borderRadius: 3,
  padding: '1px 5px',
  boxShadow: '0 0 0 1px var(--border-strong), 0 1px 3px rgba(0, 0, 0, 0.28)',
});

/**
 * dot(극값 가격 위치)과 가장자리 라벨을 잇는 옅은 세로 리더선. 극값 색을 저채도(dashed +
 * opacity)로 써서 어느 봉이 극값인지 시선을 잇되 캔들을 가리지 않는다. left 는 dot x.
 */
const leaderStyle = (color: string, top: number, height: number): CSSProperties => ({
  position: 'absolute',
  top,
  height,
  width: 0,
  borderLeft: `1px dashed ${color}`,
  opacity: 0.45,
  transform: 'translateX(-0.5px)',
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
 * 현재 보이는 뷰포트의 최고가 봉(빨강)·최저가 봉(파랑)에 작은 점(dot)을 극값 가격 위치에 찍고,
 * `<가격>원 (<±극값 대비율>%, <시각>)` 라벨은 캔들과 겹치지 않게 pane 상단(고가)·하단(저가)
 * 가장자리에 고정하며, dot↔라벨을 옅은 세로 리더선으로 잇는다.
 * PaneLegendOverlay 형제 패턴: `subscribeVisibleLogicalRangeChange` 를 rAF throttle
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

  const tokens = resolveTokensThemed(TOKEN_SPEC);
  const items = (ex
    ? [
        { kind: 'high' as const, e: ex.high, color: tokens.up, place: 'above' as const },
        { kind: 'low' as const, e: ex.low, color: tokens.down, place: 'below' as const },
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
          // 라벨 박스의 dot 쪽 모서리 y(above=박스 bottom, below=박스 top). dot(it.y)과의
          // 세로 구간을 리더선으로 잇는다. 극값이 가장자리 근처면 구간이 짧아 리더선 생략.
          const labelInnerY = label.place === 'above'
            ? label.y + LABEL_HEIGHT_PX
            : label.y - LABEL_HEIGHT_PX;
          const leaderTop = Math.min(it.y, labelInnerY);
          const leaderHeight = Math.abs(it.y - labelInnerY);
          return (
            <div key={it.kind}>
              {leaderHeight >= LEADER_MIN_HEIGHT_PX && (
                <span
                  aria-hidden="true"
                  data-testid={`highlow-leader-${it.kind}`}
                  style={{ ...leaderStyle(it.color, leaderTop, leaderHeight), left: it.x }}
                />
              )}
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
