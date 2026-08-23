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
import { resolveTokensThemed } from '../util/tokens';

// 라벨 칩 표면·테두리 — canvas 지연 해석(PeakWallSegmentsPrimitive 와 동일 처방).
const CHIP_TOKENS = {
  bg: ['--bg-card', '#121216'],
  border: ['--border-strong', '#33333C'],
} as const;
import {
  LABEL_BOX_X_PAD_PX,
  LABEL_BOX_Y_PAD_PX,
  LABEL_EDGE_PAD_PX,
  LABEL_FONT_PX,
  LABEL_ROW_GAP_PX,
  layoutPeakWallLabels,
  peakWallChipGeometry,
  peakXFromCoordinate,
  xCoordinateOrNearest,
  type PeakWallLabelCandidate,
  type PeakWallDockedLabel,
} from './PeakWallSegmentsPrimitive';
import { measureTextCached } from './util/textWidthCache';

export type PeakWallDockedLabelInput = PeakWallDockedLabel;

// 회피로 칩이 점에서 밀렸을 때만 잇는 리더선 — 고저 극값 라벨의 리더선과 같은 처방(옅은 점선).
// 밀린 거리가 짧으면 1px 얼룩만 남으므로 최소 길이 미만은 그리지 않는다.
const LEADER_OPACITY = 0.45;
const LEADER_DASH_PX: readonly [number, number] = [3, 3];
const LEADER_MIN_PX = 4;

/** 도킹 라벨 앵커 x — 세그먼트 선과 동일한 최근접 봉 클램프(xCoordinateOrNearest)를 쓴다.
 *  raw timeToCoordinate는 통합(UN) 확장 세션 경계(08:00/20:00)의 time1이 로드된 시계열
 *  범위 밖이면 null이라, 선은 그려지는데 라벨만 조용히 사라졌다(선·매물대는 #489에서
 *  클램프 적용, 라벨 프리미티브만 누락됐던 결함). */
export function dockedLabelTimeToX(
  timeScale: ITimeScaleApi<Time>,
  horizontalPixelRatio: number,
): (time: Time) => number | null {
  return (time) => {
    const x = xCoordinateOrNearest(timeScale, time);
    return x === null ? null : x * horizontalPixelRatio;
  };
}

/** 도킹 라벨 1개의 배치 후보. `layoutPeakWallLabels` 가 그대로 실어 나르는 추가 필드로
 *  점(dot)의 x·y 를 들고 다닌다 — 회피로 칩이 밀렸을 때 리더선을 그 점에 잇기 위해. */
export type PeakWallDockedLabelCandidate = PeakWallLabelCandidate & {
  peakX: number;
  lineY: number;
};

export type PeakWallDockedLabelCandidatesArgs = {
  labels: readonly PeakWallDockedLabelInput[];
  priceToY: (price: number) => number | null;
  /** 세그먼트 끝점 시각 → x(최근접 봉 클램프 포함). */
  timeToX: (time: Time) => number | null;
  /** peak 시각의 raw x — 로드 범위 밖이면 null(보간 폴백은 peakXFromCoordinate 가 처리). */
  rawPeakX: (peakTime: Time) => number | null;
  measureText: (text: string) => number;
  paneWidth: number;
  /** px 상수 → 대상 좌표계 배율. bitmap space 는 hr/vr, media space 는 1(기본). */
  horizontalScale?: number;
  verticalScale?: number;
};

/**
 * 라벨 앵커는 **선 끝(time1)이 아니라 peak 발생 봉(peakTime)** 이다. 선 끝 도킹은 모든 라벨을
 * 날 경계에 몰아 서로 겹치게 만들었고, "언제 걸린 벽인가" 도 읽히지 않았다. 기하는
 * `peakWallChipGeometry` 한 곳에만 있어 고저 라벨의 회피 rect 와 자동으로 같은 값을 쓴다.
 */
export function peakWallDockedLabelCandidates({
  labels,
  priceToY,
  timeToX,
  rawPeakX,
  measureText,
  paneWidth,
  horizontalScale = 1,
  verticalScale = 1,
}: PeakWallDockedLabelCandidatesArgs): PeakWallDockedLabelCandidate[] {
  const candidates: PeakWallDockedLabelCandidate[] = [];
  for (let i = 0; i < labels.length; i += 1) {
    const label = labels[i];
    if (label.label === '') continue;
    const lineY = priceToY(label.price);
    if (lineY === null) continue;
    const x0 = timeToX(label.time0);
    const x1 = timeToX(label.time1);
    if (x0 === null || x1 === null) continue;
    const peakX = peakXFromCoordinate(
      rawPeakX(label.peakTime),
      label.peakTime,
      label.time0,
      label.time1,
      x0,
      x1,
    );
    const width = measureText(label.label);
    const geometry = peakWallChipGeometry({
      peakX,
      dayX0: x0,
      dayX1: x1,
      lineY,
      textWidth: width,
      side: label.side,
      paneWidth,
      horizontalScale,
      verticalScale,
    });
    if (geometry === null) continue;
    candidates.push({
      index: i,
      xRight: geometry.xRight,
      yLine: geometry.baselineY,
      width,
      // 폭 컷은 peakWallChipGeometry 의 그날-구간 클램프가 흡수한다(인라인 경로 전용 가드).
      segmentWidth: Number.POSITIVE_INFINITY,
      peakX,
      lineY,
    });
  }
  return candidates;
}

type LeaderArgs = {
  peakX: number;
  lineY: number;
  desiredBaselineY: number;
  baselineY: number;
  chipLeft: number;
  chipRight: number;
  chipTop: number;
  chipBottom: number;
  color: string;
  verticalScale: number;
};

/** 회피 스택으로 칩이 원래 자리에서 밀렸거나, 클램프로 점이 칩 x 범위 밖에 남았을 때만
 *  점↔칩을 잇는다. 안 밀린 라벨까지 그으면 모든 벽에 짧은 수직 획이 붙어 오히려 시끄럽다. */
function drawPeakLabelLeader(ctx: CanvasRenderingContext2D, args: LeaderArgs): void {
  const pushedPx = Math.abs(args.baselineY - args.desiredBaselineY) / args.verticalScale;
  const offAnchor = args.peakX < args.chipLeft || args.peakX > args.chipRight;
  if (pushedPx < LEADER_MIN_PX && !offAnchor) return;
  const edgeY = Math.abs(args.lineY - args.chipBottom) <= Math.abs(args.lineY - args.chipTop)
    ? args.chipBottom
    : args.chipTop;
  const endX = Math.min(args.chipRight, Math.max(args.chipLeft, args.peakX));
  ctx.save();
  ctx.globalAlpha = LEADER_OPACITY;
  ctx.strokeStyle = args.color;
  ctx.lineWidth = Math.max(1, args.verticalScale);
  ctx.setLineDash([LEADER_DASH_PX[0] * args.verticalScale, LEADER_DASH_PX[1] * args.verticalScale]);
  ctx.beginPath();
  ctx.moveTo(args.peakX, args.lineY);
  ctx.lineTo(endX, edgeY);
  ctx.stroke();
  ctx.restore();
}

class PeakWallDockedLabelsRenderer implements IPrimitivePaneRenderer {
  private readonly _source: PeakWallDockedLabelsPrimitive;

  constructor(source: PeakWallDockedLabelsPrimitive) {
    this._source = source;
  }

  draw(target: CanvasRenderingTarget2D): void {
    const chart = this._source.chartApi();
    const series = this._source.seriesApi();
    if (!chart || !series) return;
    const labels = this._source.labelsData();
    if (labels.length === 0) return;

    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const hr = scope.horizontalPixelRatio;
      const vr = scope.verticalPixelRatio;
      ctx.font = `${LABEL_FONT_PX * vr}px sans-serif`;
      const timeScale = chart.timeScale();

      const candidates = peakWallDockedLabelCandidates({
        labels,
        priceToY: (price) => {
          const y = series.priceToCoordinate(price);
          return y === null ? null : y * vr;
        },
        timeToX: dockedLabelTimeToX(timeScale, hr),
        rawPeakX: (peakTime) => {
          const x = timeScale.timeToCoordinate(peakTime);
          return x === null ? null : x * hr;
        },
        measureText: (text) => measureTextCached(ctx, text),
        paneWidth: scope.bitmapSize.width,
        horizontalScale: hr,
        verticalScale: vr,
      });
      if (candidates.length === 0) return;

      const rowHeight = (LABEL_FONT_PX + LABEL_ROW_GAP_PX) * vr;
      const minBaselineY = (LABEL_FONT_PX + LABEL_EDGE_PAD_PX) * vr;
      const maxBaselineY = scope.bitmapSize.height - LABEL_EDGE_PAD_PX * vr;
      const layouts = layoutPeakWallLabels(candidates, minBaselineY, maxBaselineY, rowHeight);

      // 칩은 외곽선 없이 표면(fill)만 — 인라인 프리미티브와 동일 처방(방향색 텍스트 가독성용 배경).
      const { bg: chipBg } = resolveTokensThemed(CHIP_TOKENS);
      for (const layout of layouts) {
        const label = labels[layout.index];
        const xPad = LABEL_BOX_X_PAD_PX * hr;
        const yPad = LABEL_BOX_Y_PAD_PX * vr;
        const fontHeight = LABEL_FONT_PX * vr;
        const bx = layout.xRight - layout.width - xPad;
        const by = layout.baselineY - fontHeight - yPad;
        const bw = layout.width + xPad * 2;
        const bh = fontHeight + yPad * 2;
        // 리더선은 칩보다 먼저 — 칩 표면이 선 끝을 덮어 깔끔하게 맞물린다.
        drawPeakLabelLeader(ctx, {
          peakX: layout.peakX,
          lineY: layout.lineY,
          desiredBaselineY: layout.yLine,
          baselineY: layout.baselineY,
          chipLeft: bx,
          chipRight: bx + bw,
          chipTop: by,
          chipBottom: by + bh,
          color: label.color,
          verticalScale: vr,
        });
        ctx.fillStyle = chipBg;
        ctx.fillRect(bx, by, bw, bh);
        ctx.fillStyle = label.color;
        ctx.textBaseline = 'bottom';
        ctx.textAlign = 'right';
        ctx.fillText(label.label, layout.xRight, layout.baselineY);
      }
    });
  }
}

class PeakWallDockedLabelsPaneView implements IPrimitivePaneView {
  private readonly _renderer: PeakWallDockedLabelsRenderer;

  constructor(source: PeakWallDockedLabelsPrimitive) {
    this._renderer = new PeakWallDockedLabelsRenderer(source);
  }

  renderer(): IPrimitivePaneRenderer {
    return this._renderer;
  }
}

export class PeakWallDockedLabelsPrimitive implements ISeriesPrimitive<Time> {
  private _labels: readonly PeakWallDockedLabelInput[] = [];
  private _chart: IChartApi | null = null;
  private _series: ISeriesApi<SeriesType> | null = null;
  private _requestUpdate?: () => void;
  private readonly _paneView: PeakWallDockedLabelsPaneView;

  constructor() {
    this._paneView = new PeakWallDockedLabelsPaneView(this);
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
    // Pane view reads labels directly from the source during draw.
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this._paneView];
  }

  setLabels(labels: readonly PeakWallDockedLabelInput[]): void {
    this._labels = labels;
    this._requestUpdate?.();
  }

  labelsData(): readonly PeakWallDockedLabelInput[] {
    return this._labels;
  }

  chartApi(): IChartApi | null {
    return this._chart;
  }

  seriesApi(): ISeriesApi<SeriesType> | null {
    return this._series;
  }
}
