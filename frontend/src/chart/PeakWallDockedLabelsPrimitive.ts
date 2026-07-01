import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import {
  LABEL_BOX_X_PAD_PX,
  LABEL_BOX_Y_PAD_PX,
  LABEL_EDGE_PAD_PX,
  LABEL_FONT_PX,
  LABEL_GAP_PX,
  LABEL_ROW_GAP_PX,
  layoutAskPeakLabels,
  type AskPeakLabelCandidate,
  type PeakWallDockedLabel,
} from './AskPeakSegmentsPrimitive';

export type PeakWallDockedLabelInput = PeakWallDockedLabel;

export function peakWallDockedLabelCandidates(
  labels: readonly PeakWallDockedLabelInput[],
  priceToY: (price: number) => number | null,
  xRight: number,
  measureText: (text: string) => number,
  labelGapPx: number = LABEL_GAP_PX,
): AskPeakLabelCandidate[] {
  const candidates: AskPeakLabelCandidate[] = [];
  for (let i = 0; i < labels.length; i += 1) {
    const label = labels[i];
    if (label.label === '') continue;
    const y = priceToY(label.price);
    if (y === null) continue;
    candidates.push({
      index: i,
      xRight,
      yLine: y - labelGapPx,
      width: measureText(label.label),
      segmentWidth: Number.POSITIVE_INFINITY,
    });
  }
  return candidates;
}

class PeakWallDockedLabelsRenderer implements IPrimitivePaneRenderer {
  private readonly _source: PeakWallDockedLabelsPrimitive;

  constructor(source: PeakWallDockedLabelsPrimitive) {
    this._source = source;
  }

  draw(target: CanvasRenderingTarget2D): void {
    const series = this._source.seriesApi();
    if (!series) return;
    const labels = this._source.labelsData();
    if (labels.length === 0) return;

    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const hr = scope.horizontalPixelRatio;
      const vr = scope.verticalPixelRatio;
      const xRight = scope.bitmapSize.width - LABEL_EDGE_PAD_PX * hr;
      ctx.font = `${LABEL_FONT_PX * vr}px sans-serif`;

      const candidates = peakWallDockedLabelCandidates(
        labels,
        (price) => {
          const y = series.priceToCoordinate(price);
          return y === null ? null : y * vr;
        },
        xRight,
        (text) => ctx.measureText(text).width,
        LABEL_GAP_PX * vr,
      );
      if (candidates.length === 0) return;

      const rowHeight = (LABEL_FONT_PX + LABEL_ROW_GAP_PX) * vr;
      const minBaselineY = (LABEL_FONT_PX + LABEL_EDGE_PAD_PX) * vr;
      const maxBaselineY = scope.bitmapSize.height - LABEL_EDGE_PAD_PX * vr;
      const layouts = layoutAskPeakLabels(candidates, minBaselineY, maxBaselineY, rowHeight);

      for (const layout of layouts) {
        const label = labels[layout.index];
        const xPad = LABEL_BOX_X_PAD_PX * hr;
        const yPad = LABEL_BOX_Y_PAD_PX * vr;
        const fontHeight = LABEL_FONT_PX * vr;
        ctx.fillStyle = 'rgba(11, 15, 26, 0.82)';
        ctx.fillRect(
          layout.xRight - layout.width - xPad,
          layout.baselineY - fontHeight - yPad,
          layout.width + xPad * 2,
          fontHeight + yPad * 2,
        );
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
