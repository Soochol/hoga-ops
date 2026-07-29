import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  ITimeScaleApi,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { Candle } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import type { LiveTimeframe } from '../state/livePage';
import { resolveTokensThemed } from '../util/tokens';
import { computeVisibleExtremes } from '../live/visibleExtremes';
import { formatExtremeLabel } from '../live/formatExtremeLabel';
import { xCoordinateOrNearest } from './AskPeakSegmentsPrimitive';
import { measureTextCached } from './util/textWidthCache';
import {
  DOT_RADIUS_PX,
  DOT_RING_PX,
  HIGHLOW_FONT_PX,
  HIGHLOW_FONT_WEIGHT,
  LABEL_BOX_RADIUS_PX,
  LABEL_HEIGHT_PX,
  LEADER_MIN_HEIGHT_PX,
  LEADER_OPACITY,
  labelBoxWidth,
  placeExtremeLabel,
  wallLabelAvoidRect,
  type AvoidRect,
  type AvoidWallLabel,
  type ExtremeLabelPlace,
} from './highLowLabelLayout';

// DESIGN.md 성역: 상승=빨강 / 하락=파랑. 고가 라벨=빨강, 저가 라벨=파랑. candle.ts 와 동일 토큰.
// draw 에서 지연 해석 — 테마(Obsidian/Ledger) 전환 시 라벨 색이 따라온다.
const TOKEN_SPEC = {
  up: ['--price-up', '#F04452'],
  down: ['--price-down', '#3485FA'],
  // 칩 표면 = 차트 layout 배경. 캔들과 겹치지 않는 여백에선 배경에 융화돼 방향색 텍스트만
  // 뜨고, 캔들 위에선 불투명 배경이 텍스트 대비를 지킨다(외곽선·섀도 없음).
  bg: ['--bg-card', '#121216'],
} as const;

/**
 * 매 프레임 draw 가 읽는 입력. **pull 방식**인 이유: push 스냅샷은 push 시점의 축
 * 스케일에 굳지만, 팬/줌은 프레임마다 축을 바꾼다. getter 를 draw 안에서 읽어야
 * 캔들이 그려지는 바로 그 프레임의 좌표로 라벨이 산출된다(DrawingsPrimitive 선례).
 */
export type HighLowLabelsSnapshot = {
  candles: readonly Candle[];
  axis: VirtualAxis;
  timeframe: LiveTimeframe;
  /** Ask/Bid Peak(최대벽) 도킹 라벨 — 픽셀이 아닌 가격/시각. 좌표 변환은 draw 가 한다. */
  avoidWallLabels: readonly AvoidWallLabel[];
  /** Pane Legend 행 rect(캔들 pane 로컬 px) — DOM 실측이라 host 가 밀어 넣는다. */
  legendRects: readonly AvoidRect[];
};

export type HighLowLabelsSource = () => HighLowLabelsSnapshot | null;

/** 가시 시간범위(가상초 {from,to}). 초기 마운트엔 null, 차트 teardown 중엔 throw → null. */
function readVisibleRange(ts: ITimeScaleApi<Time>): { from: number; to: number } | null {
  try {
    const r = ts.getVisibleRange();
    return r ? { from: Number(r.from), to: Number(r.to) } : null;
  } catch {
    return null;
  }
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/** 도킹 wall 칩 회피 rect — draw 프레임의 축 스케일로 변환한다(축 리스케일 정합). */
function wallAvoidRects(
  chart: IChartApi,
  series: ISeriesApi<SeriesType>,
  labels: readonly AvoidWallLabel[],
  paneWidth: number,
): AvoidRect[] {
  if (labels.length === 0) return [];
  const ts = chart.timeScale();
  const rects: AvoidRect[] = [];
  try {
    // 도킹 라벨의 anchor shift(반 봉 간격) — PeakWallDockedLabelsPrimitive.draw 미러.
    const lr = ts.getVisibleLogicalRange();
    const logicalSpan = lr ? Math.abs(lr.to - lr.from) : 0;
    const halfBarSpacing = logicalSpan > 0 && paneWidth > 0 ? (paneWidth / logicalSpan) * 0.5 : 0;
    for (const wall of labels) {
      if (wall.label === '' || !Number.isFinite(wall.price)) continue;
      const yc = series.priceToCoordinate(wall.price);
      if (yc == null) continue;
      const lineEndX = xCoordinateOrNearest(ts, wall.time1);
      if (lineEndX == null) continue;
      rects.push(wallLabelAvoidRect(Math.round(Number(yc)), Number(lineEndX), wall.label, halfBarSpacing));
    }
  } catch {
    // 차트 teardown 레이스 — 회피 없이 그린다(다음 프레임 self-heal).
    return [];
  }
  return rects;
}

class HighLowLabelsRenderer implements IPrimitivePaneRenderer {
  private readonly _source: HighLowLabelsPrimitive;

  constructor(source: HighLowLabelsPrimitive) {
    this._source = source;
  }

  draw(target: CanvasRenderingTarget2D): void {
    const chart = this._source.chartApi();
    const series = this._source.seriesApi();
    const snap = this._source.snapshot();
    if (!chart || !series || snap === null) return;

    const ts = chart.timeScale();
    const ex = computeVisibleExtremes(snap.candles, snap.axis, readVisibleRange(ts));
    if (ex === null) return;

    // Media(CSS 픽셀) space — priceToCoordinate/timeToCoordinate 와 같은 단위라
    // 레이아웃 상수(px)를 배율 곱 없이 그대로 쓴다. 캔버스는 캔들 pane 자체이므로
    // mediaSize 가 곧 pane 폭·높이다(옛 DOM 오버레이의 getPane().getHeight() 불필요).
    target.useMediaCoordinateSpace((scope) => {
      const ctx = scope.context;
      const paneWidth = scope.mediaSize.width;
      const paneHeight = scope.mediaSize.height;
      if (paneWidth <= 0 || paneHeight <= 0) return;

      const tokens = resolveTokensThemed(TOKEN_SPEC);
      const avoidRects = [
        ...wallAvoidRects(chart, series, snap.avoidWallLabels, paneWidth),
        ...snap.legendRects,
      ];

      ctx.save();
      ctx.font = `${HIGHLOW_FONT_WEIGHT} ${HIGHLOW_FONT_PX}px ${resolveFontFamily()}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const items: {
        e: (typeof ex)['high'];
        color: string;
        place: ExtremeLabelPlace;
      }[] = [
        { e: ex.high, color: tokens.up, place: 'above' },
        { e: ex.low, color: tokens.down, place: 'below' },
      ];

      for (const item of items) {
        // 좌표 투영. null = 우측 빈 띠/범위 밖 → skip. try/catch = 차트 teardown 레이스에서
        // timeToCoordinate/priceToCoordinate 가 "Object is disposed" throw 시 안전 skip.
        let xc: number | null;
        let yc: number | null;
        try {
          const x = ts.timeToCoordinate(item.e.virtualSec as Time);
          const y = series.priceToCoordinate(item.e.price);
          xc = x == null ? null : Number(x);
          yc = y == null ? null : Number(y);
        } catch {
          continue;
        }
        if (xc === null || yc === null) continue;

        const text = formatExtremeLabel(item.e.price, item.e.pct, item.e.tsMs, snap.timeframe);
        const boxWidth = labelBoxWidth(measureTextCached(ctx, text));
        const label = placeExtremeLabel(item.place, xc, yc, boxWidth, paneWidth, paneHeight, avoidRects);

        // 라벨 박스의 dot 쪽 모서리 y(above=박스 bottom, below=박스 top). dot 과의 세로
        // 구간을 리더선으로 잇는다. 극값이 가장자리 근처면 구간이 짧아 리더선 생략.
        const labelInnerY = label.place === 'above'
          ? label.y + LABEL_HEIGHT_PX
          : label.y - LABEL_HEIGHT_PX;
        const leaderTop = Math.min(yc, labelInnerY);
        const leaderHeight = Math.abs(yc - labelInnerY);

        // 옅은 세로 리더선 — 어느 봉이 극값인지 시선을 잇되 캔들을 가리지 않는다.
        if (leaderHeight >= LEADER_MIN_HEIGHT_PX) {
          ctx.save();
          ctx.globalAlpha = LEADER_OPACITY;
          ctx.strokeStyle = item.color;
          ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          // 0.5 오프셋 — 1px 선을 픽셀 격자에 앉혀 흐릿함을 막는다.
          const lineX = Math.round(xc) + 0.5;
          ctx.moveTo(lineX, leaderTop);
          ctx.lineTo(lineX, leaderTop + leaderHeight);
          ctx.stroke();
          ctx.restore();
        }

        // dot — 극값 가격 위치. 배경색 링으로 같은 방향색 캔들 위에서도 파묻히지 않는다.
        ctx.beginPath();
        ctx.arc(xc, yc, DOT_RADIUS_PX + DOT_RING_PX, 0, Math.PI * 2);
        ctx.fillStyle = tokens.bg;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(xc, yc, DOT_RADIUS_PX, 0, Math.PI * 2);
        ctx.fillStyle = item.color;
        ctx.fill();

        // 칩 — 앵커(label.y)는 pane-가장자리 쪽 모서리(above=top, below=bottom).
        const boxTop = label.place === 'above' ? label.y : label.y - LABEL_HEIGHT_PX;
        const boxLeft = label.x - boxWidth / 2;
        roundRectPath(ctx, boxLeft, boxTop, boxWidth, LABEL_HEIGHT_PX, LABEL_BOX_RADIUS_PX);
        ctx.fillStyle = tokens.bg;
        ctx.fill();
        ctx.fillStyle = item.color;
        ctx.fillText(text, label.x, boxTop + LABEL_HEIGHT_PX / 2);
      }

      ctx.restore();
    });
  }
}

const FONT_TOKEN = {
  family: ['--font-data', "'Pretendard Variable', Pretendard, ui-sans-serif, system-ui, sans-serif"],
} as const;

function resolveFontFamily(): string {
  return resolveTokensThemed(FONT_TOKEN).family;
}

class HighLowLabelsPaneView implements IPrimitivePaneView {
  private readonly _renderer: HighLowLabelsRenderer;

  constructor(source: HighLowLabelsPrimitive) {
    this._renderer = new HighLowLabelsRenderer(source);
  }

  renderer(): IPrimitivePaneRenderer {
    return this._renderer;
  }
}

/**
 * /live 캔들 pane 의 **고저 극값 라벨**(CONTEXT.md `High/Low Extreme Labels`).
 * 현재 보이는 뷰포트의 최고가 봉(빨강)·최저가 봉(파랑)에 dot 을 극값 가격 위치에 찍고,
 * `<가격>원 (<±극값 대비율>%, <시각>)` 라벨을 캔들과 겹치지 않게 pane 상단(고가)·하단(저가)
 * 가장자리에 고정하며, dot↔라벨을 옅은 세로 리더선으로 잇는다.
 *
 * DOM 오버레이가 아니라 primitive 인 이유: DOM 은 `subscribeVisibleLogicalRangeChange`
 * → rAF → React 렌더 경로라, lwc 가 이미 rAF **안에서** 구독을 발화하므로 예약된 rAF 는
 * 반드시 다음 프레임으로 밀린다. 결과가 팬 중 라벨이 캔들보다 한 프레임 늦게 따라오는
 * 지연이었다. primitive.draw 는 캔들과 같은 프레임·같은 캔버스 패스에서 호출되어 지연이
 * 구조적으로 0이 된다(그리기 도구 primitive 이관과 동일 처방).
 */
export class HighLowLabelsPrimitive implements ISeriesPrimitive<Time> {
  private readonly _source: HighLowLabelsSource;
  private _chart: IChartApi | null = null;
  private _series: ISeriesApi<SeriesType> | null = null;
  private _requestUpdate?: () => void;
  private readonly _paneView: HighLowLabelsPaneView;

  constructor(source: HighLowLabelsSource) {
    this._source = source;
    this._paneView = new HighLowLabelsPaneView(this);
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this._chart = param.chart;
    this._series = param.series;
    this._requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this._chart = null;
    this._series = null;
    this._requestUpdate = undefined;
  }

  updateAllViews(): void {
    // Pane view pulls from the source at draw time.
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this._paneView];
  }

  /** 데이터/설정이 바뀌었을 때 host 가 호출 — 팬/줌은 lwc 가 알아서 다시 그린다. */
  requestUpdate(): void {
    this._requestUpdate?.();
  }

  snapshot(): HighLowLabelsSnapshot | null {
    return this._source();
  }

  chartApi(): IChartApi | null {
    return this._chart;
  }

  seriesApi(): ISeriesApi<SeriesType> | null {
    return this._series;
  }
}
