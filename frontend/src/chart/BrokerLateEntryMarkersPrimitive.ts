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
  layoutBrokerLateEntryLabels,
  type BrokerLateEntryLabelGroup,
  type BrokerLateEntryMarkerPoint,
} from './projectors/brokerLateEntryMarkers';

export const BROKER_LATE_ENTRY_MARKER_STYLE = {
  dotRadiusPx: 4,
  labelFontPx: 13,
} as const;

const DOT_RADIUS_PX = BROKER_LATE_ENTRY_MARKER_STYLE.dotRadiusPx;
const LABEL_FONT_PX = BROKER_LATE_ENTRY_MARKER_STYLE.labelFontPx;
const LABEL_OFFSET_Y_PX = 12;
const LABEL_STACK_STEP_PX = 14;
const LABEL_CHIP_GAP_X_PX = 6;
const LABEL_CHIP_X_PAD_PX = 5;
const LABEL_CHIP_Y_PAD_PX = 2;
const LABEL_MIN_HORIZONTAL_GAP_PX = 6;
const LABEL_MIN_VERTICAL_GAP_PX = 4;
const MIXED_ACCENT_RADIUS_PX = 1.5;
const MIXED_ACCENT_GAP_PX = 5;
const MIXED_ACCENT_AREA_PX = 10;
const CHIP_BG = 'rgba(11, 15, 26, 0.78)';
const CHIP_TEXT = '#E5E7EB';

type MarkerCoordinate = {
  x: number;
  y: number;
};

export function isBrokerLateEntryMarkerVisibleInPane(
  coordinate: MarkerCoordinate,
  paneWidthPx: number,
  paneHeightPx: number,
): boolean {
  return coordinate.x >= 0
    && coordinate.x <= paneWidthPx
    && coordinate.y >= 0
    && coordinate.y <= paneHeightPx;
}

export function brokerLateEntryMarkerXCoordinate(
  marker: BrokerLateEntryMarkerPoint,
  timeToCoordinate: (time: Time) => number | null,
): number | null {
  return timeToCoordinate(marker.time) ?? timeToCoordinate(marker.anchorTime);
}

export function shouldUseFullBrokerLateEntryLabels(
  markers: readonly BrokerLateEntryMarkerPoint[],
  plotted: ReadonlyMap<BrokerLateEntryMarkerPoint, MarkerCoordinate>,
  paneWidthPx: number,
  paneHeightPx: number,
  labelHeightPx: number,
  labelStackStepPx: number,
  estimateLabelWidthPx: (label: string) => number = () => 0,
  minHorizontalGapPx = 0,
  minVerticalGapPx = 0,
): boolean {
  if (markers.length <= 1) return true;
  const density = paneWidthPx > 0 ? markers.length / paneWidthPx : Number.POSITIVE_INFINITY;
  const stackCounts = new Map<number, number>();
  for (const marker of markers) {
    const coord = plotted.get(marker);
    if (!coord) continue;
    const key = Math.round(coord.x);
    stackCounts.set(key, (stackCounts.get(key) ?? 0) + 1);
  }
  const tallestStack = Math.max(1, ...stackCounts.values());
  const stackHeight = labelHeightPx + (tallestStack - 1) * labelStackStepPx;
  if (density > 0.035 || stackHeight > paneHeightPx * 0.6) return false;

  const stackOffsets = new Map<number, number>();
  const boxes = markers.flatMap((marker) => {
    const coord = plotted.get(marker);
    if (!coord) return [];
    const key = Math.round(coord.x);
    const stackIndex = stackOffsets.get(key) ?? 0;
    stackOffsets.set(key, stackIndex + 1);
    const left = coord.x + LABEL_CHIP_GAP_X_PX;
    const top = coord.y - LABEL_OFFSET_Y_PX - stackIndex * labelStackStepPx - labelHeightPx / 2;
    return [{
      key,
      left,
      right: left + estimateLabelWidthPx(marker.label),
      top,
      bottom: top + labelHeightPx,
    }];
  });

  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.key === b.key) continue;
      const overlaps = a.left <= b.right + minHorizontalGapPx
        && b.left <= a.right + minHorizontalGapPx
        && a.top <= b.bottom + minVerticalGapPx
        && b.top <= a.bottom + minVerticalGapPx;
      if (overlaps) return false;
    }
  }
  return true;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function fillRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fill();
}

function groupLabelColor(group: BrokerLateEntryLabelGroup): string {
  return group.side === 'mixed' ? CHIP_TEXT : group.color;
}

class BrokerLateEntryMarkersRenderer implements IPrimitivePaneRenderer {
  private readonly _source: BrokerLateEntryMarkersPrimitive;

  constructor(source: BrokerLateEntryMarkersPrimitive) {
    this._source = source;
  }

  draw(target: CanvasRenderingTarget2D): void {
    const chart = this._source.chartApi();
    const series = this._source.seriesApi();
    if (!chart || !series) return;
    const timeScale = chart.timeScale();
    const markers = this._source.markersData();
    if (markers.length === 0) return;

    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const hr = scope.horizontalPixelRatio;
      const vr = scope.verticalPixelRatio;
      const dotRadius = DOT_RADIUS_PX * hr;
      const labelChipGapX = LABEL_CHIP_GAP_X_PX * hr;
      const labelHeight = (LABEL_FONT_PX + LABEL_CHIP_Y_PAD_PX * 2) * vr;
      const labelOffsetY = LABEL_OFFSET_Y_PX * vr;
      const labelStackStep = LABEL_STACK_STEP_PX * vr;
      const labelPadX = LABEL_CHIP_X_PAD_PX * hr;
      const accentArea = MIXED_ACCENT_AREA_PX * hr;
      const accentRadius = MIXED_ACCENT_RADIUS_PX * hr;
      const accentGap = MIXED_ACCENT_GAP_PX * vr;
      const plotted = new Map<BrokerLateEntryMarkerPoint, MarkerCoordinate>();

      ctx.font = `${LABEL_FONT_PX * vr}px sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';

      for (const marker of markers) {
        const x = brokerLateEntryMarkerXCoordinate(
          marker,
          (time) => timeScale.timeToCoordinate(time),
        );
        const y = series.priceToCoordinate(marker.price);
        if (x === null || y === null) continue;
        const px = x * hr;
        const py = y * vr;
        if (!isBrokerLateEntryMarkerVisibleInPane(
          { x: px, y: py },
          scope.bitmapSize.width,
          scope.bitmapSize.height,
        )) {
          continue;
        }
        plotted.set(marker, { x: px, y: py });
        ctx.beginPath();
        ctx.arc(px, py, dotRadius, 0, Math.PI * 2);
        ctx.fillStyle = marker.color;
        ctx.fill();
      }

      if (plotted.size === 0) return;

      const visibleMarkers = markers.filter((marker) => plotted.has(marker));
      const forceFullLabels = shouldUseFullBrokerLateEntryLabels(
        visibleMarkers,
        plotted,
        scope.bitmapSize.width,
        scope.bitmapSize.height,
        labelHeight,
        labelStackStep,
        (label) => ctx.measureText(label).width + 10 * hr,
        LABEL_MIN_HORIZONTAL_GAP_PX * hr,
        LABEL_MIN_VERTICAL_GAP_PX * vr,
      );
      const groups = layoutBrokerLateEntryLabels(visibleMarkers, {
        minHorizontalGapPx: LABEL_MIN_HORIZONTAL_GAP_PX * hr,
        minVerticalGapPx: LABEL_MIN_VERTICAL_GAP_PX * vr,
        labelHeightPx: labelHeight,
        estimateLabelWidthPx: (label) => ctx.measureText(label).width + 10 * hr,
        getX: (marker) => plotted.get(marker)!.x + labelChipGapX,
        getY: (marker) => plotted.get(marker)!.y - labelOffsetY,
        forceFull: forceFullLabels,
      }).groups;

      const stackByX = new Map<number, number>();
      for (const group of groups) {
        const coordinates = group.markers
          .map((marker) => plotted.get(marker))
          .filter((coord): coord is MarkerCoordinate => coord != null);
        if (coordinates.length === 0) continue;

        const sameXKey = Math.round(coordinates[0].x);
        const stackIndex = group.markers.length === 1
          ? (stackByX.get(sameXKey) ?? 0)
          : 0;
        if (group.markers.length === 1) {
          stackByX.set(sameXKey, stackIndex + 1);
        }

        const anchorX = Math.min(...coordinates.map((coord) => coord.x)) + labelChipGapX;
        const anchorY = Math.min(...coordinates.map((coord) => coord.y))
          - labelOffsetY
          - stackIndex * labelStackStep;
        const textWidth = ctx.measureText(group.label).width;
        const mixed = group.side === 'mixed';
        const chipWidth = textWidth + labelPadX * 2 + (mixed ? accentArea : 0);
        const chipHeight = labelHeight;
        const left = clamp(anchorX, 1, Math.max(1, scope.bitmapSize.width - chipWidth - 1));
        const top = clamp(
          anchorY - chipHeight / 2,
          1,
          Math.max(1, scope.bitmapSize.height - chipHeight - 1),
        );

        ctx.fillStyle = CHIP_BG;
        fillRoundedRect(ctx, left, top, chipWidth, chipHeight, 4 * hr);

        if (mixed) {
          const buyColor = group.markers.find((marker) => marker.side === 'buy')?.color ?? '#ef4444';
          const sellColor = group.markers.find((marker) => marker.side === 'sell')?.color ?? '#3b82f6';
          const accentX = left + labelPadX;
          const accentCenterY = top + chipHeight / 2;

          ctx.beginPath();
          ctx.arc(accentX, accentCenterY - accentGap / 2, accentRadius, 0, Math.PI * 2);
          ctx.fillStyle = buyColor;
          ctx.fill();

          ctx.beginPath();
          ctx.arc(accentX, accentCenterY + accentGap / 2, accentRadius, 0, Math.PI * 2);
          ctx.fillStyle = sellColor;
          ctx.fill();
        }

        ctx.fillStyle = groupLabelColor(group);
        ctx.fillText(
          group.label,
          left + labelPadX + (mixed ? accentArea : 0),
          top + chipHeight / 2,
        );
      }
    });
  }
}

class BrokerLateEntryMarkersPaneView implements IPrimitivePaneView {
  private readonly _renderer: BrokerLateEntryMarkersRenderer;

  constructor(source: BrokerLateEntryMarkersPrimitive) {
    this._renderer = new BrokerLateEntryMarkersRenderer(source);
  }

  renderer(): IPrimitivePaneRenderer {
    return this._renderer;
  }
}

export class BrokerLateEntryMarkersPrimitive implements ISeriesPrimitive<Time> {
  private _markers: readonly BrokerLateEntryMarkerPoint[] = [];
  private _chart: IChartApi | null = null;
  private _series: ISeriesApi<SeriesType> | null = null;
  private _requestUpdate?: () => void;
  private readonly _paneView: BrokerLateEntryMarkersPaneView;

  constructor() {
    this._paneView = new BrokerLateEntryMarkersPaneView(this);
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
    // pane view는 매 draw에서 source를 직접 읽으므로 별도 캐시 갱신이 없다.
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return [this._paneView];
  }

  setMarkers(markers: readonly BrokerLateEntryMarkerPoint[]): void {
    this._markers = markers;
    this._requestUpdate?.();
  }

  markersData(): readonly BrokerLateEntryMarkerPoint[] {
    return this._markers;
  }

  chartApi(): IChartApi | null {
    return this._chart;
  }

  seriesApi(): ISeriesApi<SeriesType> | null {
    return this._series;
  }
}
