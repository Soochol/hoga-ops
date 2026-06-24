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

/**
 * 거래일별 "매도 최대벽"을 그날 구간에만 걸치는 수평 세그먼트로 그리는 커스텀 series primitive.
 *
 * lwc 기본 price line은 차트 전폭이라 여러 날을 못 그린다. 그래서 surge 마커와 같은 방식으로
 * `timeScale.timeToCoordinate(time)`(x) + series의 `priceToCoordinate(price)`(y)로 직접 그린다 —
 * 각 세그먼트는 [time0, time1] x-구간(그날 open→close, 오늘은 라이브 엣지) × price y에 수평선.
 * series 길이/timeScale index와 무관해 좌측-팬 백필에도 면역(SurgeMarkersPrimitive와 동일 근거).
 */
export interface AskPeakSegment {
  /** 그날 시작 — axis.toVirtual(open)/1000 (가상 초, 라인 점과 동일 좌표계). */
  time0: Time;
  /** 그날 끝 — 과거일=close, 오늘=라이브 엣지(마지막 캔들). */
  time1: Time;
  /** peak이 실제 걸린 시점 — 이 x에 점을 찍어 그 날 언제 최대벽이었는지 표시. */
  peakTime: Time;
  /** 그날 최대 매도벽 가격(priceToCoordinate 입력). */
  price: number;
  /** 가격·물량 라벨(예: "150,000, 16.5k"). 빈 문자열이면 라벨 생략. */
  label: string;
  color: string;
  lineWidth: number;
  /** 오늘(라이브) 세그먼트 여부(스타일 구분용). */
  live?: boolean;
}

const PEAK_DOT_RADIUS_PX = 3.5;
const LABEL_GAP_PX = 3;
const LABEL_FONT_PX = 11;
const LABEL_ROW_GAP_PX = 2;
const LABEL_EDGE_PAD_PX = 4;
const LABEL_SEGMENT_PAD_PX = 8;

export type AskPeakLabelCandidate = {
  index: number;
  xRight: number;
  yLine: number;
  width: number;
  segmentWidth: number;
};

export type AskPeakLabelLayout = AskPeakLabelCandidate & {
  baselineY: number;
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function labelsOverlap(a: AskPeakLabelLayout, b: AskPeakLabelLayout, rowHeight: number): boolean {
  const aLeft = a.xRight - a.width;
  const bLeft = b.xRight - b.width;
  const xOverlaps = aLeft <= b.xRight && bLeft <= a.xRight;
  const yOverlaps = Math.abs(a.baselineY - b.baselineY) < rowHeight;
  return xOverlaps && yOverlaps;
}

function labelXOverlaps(a: AskPeakLabelLayout, b: AskPeakLabelLayout): boolean {
  const aLeft = a.xRight - a.width;
  const bLeft = b.xRight - b.width;
  return aLeft <= b.xRight && bLeft <= a.xRight;
}

function overlappingLabelGroups(layouts: readonly AskPeakLabelLayout[]): AskPeakLabelLayout[][] {
  const groups: AskPeakLabelLayout[][] = [];
  for (const layout of layouts) {
    const matches = groups.filter((group) => group.some((item) => labelXOverlaps(item, layout)));
    if (matches.length === 0) {
      groups.push([layout]);
      continue;
    }
    const merged = matches.flat().concat(layout);
    for (const match of matches) {
      groups.splice(groups.indexOf(match), 1);
    }
    groups.push(merged);
  }
  return groups;
}

export function visibleAskPeakLabelCandidates(
  candidates: readonly AskPeakLabelCandidate[],
  segmentPad: number,
): AskPeakLabelCandidate[] {
  return candidates.filter((candidate) => candidate.segmentWidth >= candidate.width + segmentPad * 2);
}

/**
 * Canvas 라벨은 DOM 레이아웃 도움을 못 받으므로, 같은 화면 영역의 라벨끼리만 baseline을 벌린다.
 * 원래 선 위 위치를 우선하되 겹치면 아래쪽 빈 슬롯으로 내리고, pane 밖으로 나가면 위로 되민다.
 */
export function layoutAskPeakLabels(
  candidates: readonly AskPeakLabelCandidate[],
  minBaselineY: number,
  maxBaselineY: number,
  rowHeight: number,
): AskPeakLabelLayout[] {
  const layouts: AskPeakLabelLayout[] = [];
  const sorted = candidates.slice().sort((a, b) => a.yLine - b.yLine || a.xRight - b.xRight || a.index - b.index);
  for (const c of sorted) {
    let baselineY = clamp(c.yLine, minBaselineY, maxBaselineY);
    for (const placed of layouts) {
      if (labelsOverlap({ ...c, baselineY }, placed, rowHeight)) {
        baselineY = Math.max(baselineY, placed.baselineY + rowHeight);
      }
    }
    layouts.push({ ...c, baselineY });
  }
  for (const group of overlappingLabelGroups(layouts)) {
    const maxY = Math.max(...group.map((layout) => layout.baselineY));
    const overflow = Math.max(0, maxY - maxBaselineY);
    if (overflow > 0) {
      for (const layout of group) layout.baselineY -= overflow;
    }
    const minY = Math.min(...group.map((layout) => layout.baselineY));
    const underflow = Math.max(0, minBaselineY - minY);
    if (underflow > 0) {
      for (const layout of group) layout.baselineY += underflow;
    }
  }
  return layouts
    .map((layout) => ({ ...layout, baselineY: clamp(layout.baselineY, minBaselineY, maxBaselineY) }))
    .sort((a, b) => a.index - b.index);
}

class AskPeakSegmentsRenderer implements IPrimitivePaneRenderer {
  private readonly _source: AskPeakSegmentsPrimitive;
  constructor(source: AskPeakSegmentsPrimitive) {
    this._source = source;
  }

  draw(target: CanvasRenderingTarget2D): void {
    const chart = this._source.chartApi();
    const series = this._source.seriesApi();
    if (!chart || !series) return;
    const timeScale = chart.timeScale();
    const segments = this._source.segmentsData();
    if (segments.length === 0) return;
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const hr = scope.horizontalPixelRatio;
      const vr = scope.verticalPixelRatio;
      const labelCandidates: AskPeakLabelCandidate[] = [];
      for (let i = 0; i < segments.length; i += 1) {
        const s = segments[i];
        const x0 = timeScale.timeToCoordinate(s.time0);
        const x1 = timeScale.timeToCoordinate(s.time1);
        const y = series.priceToCoordinate(s.price);
        if (x0 === null || x1 === null || y === null) continue;
        const px0 = x0 * hr;
        const px1 = x1 * hr;
        const py = y * vr;
        // 수평 세그먼트.
        ctx.beginPath();
        ctx.strokeStyle = s.color;
        ctx.lineWidth = Math.max(1, s.lineWidth) * vr;
        ctx.moveTo(px0, py);
        ctx.lineTo(px1, py);
        ctx.stroke();
        // peak 발생 시점 점(그 날 언제 최대벽이었는지). timeToCoordinate(peakTime)가 정확하지만,
        // peak 시각이 로드된 캔들 범위 밖이면 null을 내 점이 누락된다(일부만 보이던 버그). 그럴 때는
        // 세그먼트 끝점(x0~x1) 사이를 peakTime의 [time0,time1] 내 위치로 선형 보간해 폴백 — 선이
        // 그려지는 한 점도 항상 그려진다(보간은 세션 내 가상시각이 x와 단조라 근사 정확).
        let xPeak: number | null = timeScale.timeToCoordinate(s.peakTime);
        if (xPeak === null) {
          const t0 = s.time0 as unknown as number;
          const t1 = s.time1 as unknown as number;
          const tp = s.peakTime as unknown as number;
          const frac = t1 > t0 ? Math.min(1, Math.max(0, (tp - t0) / (t1 - t0))) : 0;
          xPeak = (x0 as number) + frac * ((x1 as number) - (x0 as number));
        }
        ctx.beginPath();
        ctx.arc(xPeak * hr, py, PEAK_DOT_RADIUS_PX * hr, 0, Math.PI * 2);
        ctx.fillStyle = s.color;
        ctx.fill();
        // 라벨은 선/점 렌더 후 한 번에 배치해 가까운 가격대의 텍스트 겹침을 피한다.
        if (s.label) {
          ctx.font = `${LABEL_FONT_PX * vr}px sans-serif`;
          labelCandidates.push({
            index: i,
            xRight: px1,
            yLine: py - LABEL_GAP_PX * vr,
            width: ctx.measureText(s.label).width,
            segmentWidth: Math.abs(px1 - px0),
          });
        }
      }
      if (labelCandidates.length === 0) return;
      const rowHeight = (LABEL_FONT_PX + LABEL_ROW_GAP_PX) * vr;
      const minBaselineY = (LABEL_FONT_PX + LABEL_EDGE_PAD_PX) * vr;
      const maxBaselineY = scope.bitmapSize.height - LABEL_EDGE_PAD_PX * vr;
      const visibleLabels = visibleAskPeakLabelCandidates(labelCandidates, LABEL_SEGMENT_PAD_PX * hr);
      const labelLayouts = layoutAskPeakLabels(visibleLabels, minBaselineY, maxBaselineY, rowHeight);
      for (const layout of labelLayouts) {
        const s = segments[layout.index];
        ctx.font = `${LABEL_FONT_PX * vr}px sans-serif`;
        ctx.fillStyle = s.color;
        ctx.textBaseline = 'bottom';
        ctx.textAlign = 'right';
        ctx.fillText(s.label, layout.xRight, layout.baselineY);
      }
    });
  }
}

class AskPeakSegmentsPaneView implements IPrimitivePaneView {
  private readonly _renderer: AskPeakSegmentsRenderer;
  constructor(source: AskPeakSegmentsPrimitive) {
    this._renderer = new AskPeakSegmentsRenderer(source);
  }
  renderer(): IPrimitivePaneRenderer {
    return this._renderer;
  }
}

export class AskPeakSegmentsPrimitive implements ISeriesPrimitive<Time> {
  private _segments: readonly AskPeakSegment[] = [];
  private _chart: IChartApi | null = null;
  private _series: ISeriesApi<SeriesType> | null = null;
  private _requestUpdate?: () => void;
  private readonly _paneView: AskPeakSegmentsPaneView;

  constructor() {
    this._paneView = new AskPeakSegmentsPaneView(this);
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

  setSegments(segments: readonly AskPeakSegment[]): void {
    this._segments = segments;
    this._requestUpdate?.();
  }
  segmentsData(): readonly AskPeakSegment[] {
    return this._segments;
  }
  chartApi(): IChartApi | null {
    return this._chart;
  }
  seriesApi(): ISeriesApi<SeriesType> | null {
    return this._series;
  }
}
