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
  /** 물량 라벨(예: "12.3k"). 빈 문자열이면 라벨 생략. */
  label: string;
  color: string;
  lineWidth: number;
  /** 오늘(라이브) 세그먼트 여부(스타일 구분용). */
  live?: boolean;
}

const PEAK_DOT_RADIUS_PX = 3.5;
const LABEL_GAP_PX = 3;
const LABEL_FONT_PX = 11;

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
      for (const s of segments) {
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
        // peak 발생 시점 점(그 날 언제 최대벽이었는지). 세그먼트 x-구간 안에 있으면 찍는다.
        const xPeak = timeScale.timeToCoordinate(s.peakTime);
        if (xPeak !== null) {
          ctx.beginPath();
          ctx.arc(xPeak * hr, py, PEAK_DOT_RADIUS_PX * hr, 0, Math.PI * 2);
          ctx.fillStyle = s.color;
          ctx.fill();
        }
        // 라벨(선 위, 오른쪽 끝 정렬).
        if (s.label) {
          ctx.font = `${LABEL_FONT_PX * vr}px sans-serif`;
          ctx.fillStyle = s.color;
          ctx.textBaseline = 'bottom';
          ctx.textAlign = 'right';
          ctx.fillText(s.label, px1, py - LABEL_GAP_PX * vr);
        }
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
