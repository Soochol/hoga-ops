import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  IRange,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import { rankVisiblePeakSegments } from '../live/peakWallVisibleRanking';
import { xCoordinateOrNearest, type PeakWallLabelSide } from './AskPeakSegmentsPrimitive';

/**
 * 당일 최대벽 **순위 화살표** — 보이는 영역 잔량 상위 N 개의 벽이 걸린 분봉을 캔들
 * 바깥쪽에 화살표 + 순위 숫자로 찍는다(매도 ↓ 고가 위 · 매수 ↑ 저가 아래).
 *
 * 왜 필요한가: 벽 선·점·도킹 라벨은 전부 **벽 가격** y 에 붙는다. 벽이 캔들에서 멀면
 * "그게 어느 분봉이었나" 가 눈에 안 들어온다. 이 마커만 앵커가 **캔들 극값**이라,
 * 레전드의 ①②③ 과 차트의 봉이 1:1 로 이어진다.
 *
 * ⚠ **`WallSurgeMarkersPrimitive` 의 ▼/▲ 와 같은 pane 에 공존한다.** 그쪽은 속 찬
 * 삼각형이 「호가벽 급증」을 뜻하므로, 여기서는 **축(shaft)이 있는 화살표 + 순위 숫자**
 * 로 형태를 가른다. 숫자가 결정적 구분자다 — 급증 마커에는 숫자가 없다.
 *
 * ⚠ lwc 기본 `createSeriesMarkers` 를 쓰지 않는 이유는 `SurgeMarkersPrimitive` 주석과
 * 같다(공유 timeScale 의 logical index 를 되먹여 시리즈 길이가 다르면 통째로 밀린다).
 * x 는 `xCoordinateOrNearest` 로 잡는다 — raw `timeToCoordinate` 는 통합(UN) 확장 세션
 * 경계에서 null 이라, 선은 그려지는데 마커만 조용히 사라진다(#489 와 같은 결함).
 */
export interface PeakWallRankArrow {
  /** 발생 분봉의 가상초(캔들 버킷에 스냅됨) — 화살표 x 앵커. */
  time: Time;
  /** 그날 구간 — 보이는 영역 겹침 판정(레전드·선 강조와 **같은 규칙**). */
  time0: Time;
  time1: Time;
  /** 잔량 — 랭킹 정렬 키. */
  qty: number;
  /** 화살표가 매달릴 가격. 매도=그 봉의 고가, 매수=그 봉의 저가. */
  anchorPrice: number;
  side: PeakWallLabelSide;
  /** 그 벽의 선 색 그대로 — 1위는 「보이는 영역 최대벽」 강조 색을 자동으로 물려받는다. */
  color: string;
}

/** 캔들 극값과 화살표 끝 사이. */
export const ARROW_GAP_PX = 4;
export const ARROW_HEIGHT_PX = 11;
export const ARROW_HEAD_HEIGHT_PX = 5;
export const ARROW_HALF_WIDTH_PX = 3.5;
export const ARROW_SHAFT_WIDTH_PX = 1.5;
/** 화살표 꼬리와 순위 숫자 사이. */
export const RANK_GAP_PX = 2;
export const RANK_FONT_PX = 10;

/**
 * 화살표 한 개가 차지하는 캔들 pane 로컬 CSS px 사각형(숫자 포함).
 *
 * `anchorY` 는 캔들 극값의 y. 매도는 위로(음의 방향), 매수는 아래로 자란다. 고저 극값
 * 라벨의 회피 입력으로도 쓰이므로 **순수 기하**로 떼어 두고 단위 테스트한다.
 */
export function rankArrowRect(
  anchorY: number,
  side: PeakWallLabelSide,
  centerX: number,
): { top: number; bottom: number; left: number; right: number } {
  const total = ARROW_GAP_PX + ARROW_HEIGHT_PX + RANK_GAP_PX + RANK_FONT_PX;
  const half = Math.max(ARROW_HALF_WIDTH_PX, RANK_FONT_PX / 2);
  return side === 'ask'
    ? { top: anchorY - total, bottom: anchorY, left: centerX - half, right: centerX + half }
    : { top: anchorY, bottom: anchorY + total, left: centerX - half, right: centerX + half };
}

class PeakWallRankArrowsRenderer implements IPrimitivePaneRenderer {
  private readonly _source: PeakWallRankArrowsPrimitive;

  constructor(source: PeakWallRankArrowsPrimitive) {
    this._source = source;
  }

  draw(target: CanvasRenderingTarget2D): void {
    const chart = this._source.chartApi();
    const series = this._source.seriesApi();
    const arrows = this._source.arrowsData();
    if (!chart || !series || arrows.length === 0) return;
    const timeScale = chart.timeScale();
    // 선정은 **draw 시점**이다 — 팬·줌마다 draw 가 다시 도니 별도 구독 없이 따라오고,
    // 레전드 provider 가 같은 순간의 범위를 읽으므로 둘이 다른 프레임의 상위 N 을
    // 보일 수 없다(`WallSurgeMarkersPrimitive` 가 문서화한 같은 처방).
    const visibleRange = timeScale.getVisibleRange() as IRange<Time> | null;
    const ranked = rankVisiblePeakSegments(arrows, visibleRange, this._source.rankLimit());
    if (ranked.length === 0) return;

    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const hr = scope.horizontalPixelRatio;
      const vr = scope.verticalPixelRatio;
      const gap = ARROW_GAP_PX * vr;
      const height = ARROW_HEIGHT_PX * vr;
      const headHeight = ARROW_HEAD_HEIGHT_PX * vr;
      const halfW = ARROW_HALF_WIDTH_PX * hr;
      const shaftW = Math.max(1, ARROW_SHAFT_WIDTH_PX * hr);
      const rankGap = RANK_GAP_PX * vr;
      const fontPx = RANK_FONT_PX * vr;

      ctx.save();
      ctx.textAlign = 'center';
      ctx.font = `600 ${fontPx}px sans-serif`;
      ranked.forEach((index, rank) => {
        const a = arrows[index];
        const x = xCoordinateOrNearest(timeScale, a.time);
        const y = series.priceToCoordinate(a.anchorPrice);
        if (x === null || y === null) return;
        const cx = x * hr;
        const anchorY = y * vr;
        if (cx < 0 || cx > scope.bitmapSize.width) return;
        // 매도는 위로, 매수는 아래로. dir 하나로 두 방향을 같은 식에 태운다.
        const dir = a.side === 'ask' ? -1 : 1;
        const tipY = anchorY + dir * gap;
        const tailY = tipY + dir * height;
        const headBaseY = tipY + dir * headHeight;

        ctx.fillStyle = a.color;
        ctx.strokeStyle = a.color;
        // 축(shaft) — 급증 마커의 속 찬 삼각형과 형태를 가르는 부분.
        ctx.lineWidth = shaftW;
        ctx.beginPath();
        ctx.moveTo(cx, tailY);
        ctx.lineTo(cx, headBaseY);
        ctx.stroke();
        // 머리(head).
        ctx.beginPath();
        ctx.moveTo(cx, tipY);
        ctx.lineTo(cx - halfW, headBaseY);
        ctx.lineTo(cx + halfW, headBaseY);
        ctx.closePath();
        ctx.fill();
        // 순위 숫자 — 레전드의 1/2/3 과 **같은 랭커**에서 나오므로 항상 일치한다.
        // baseline 은 텍스트 아랫변이라 매도는 꼬리 위, 매수는 꼬리 아래 한 줄.
        ctx.textBaseline = a.side === 'ask' ? 'bottom' : 'top';
        ctx.fillText(String(rank + 1), cx, tailY + dir * rankGap);
      });
      ctx.restore();
    });
  }
}

class PeakWallRankArrowsPaneView implements IPrimitivePaneView {
  private readonly _renderer: PeakWallRankArrowsRenderer;
  constructor(source: PeakWallRankArrowsPrimitive) {
    this._renderer = new PeakWallRankArrowsRenderer(source);
  }
  renderer(): IPrimitivePaneRenderer {
    return this._renderer;
  }
}

export class PeakWallRankArrowsPrimitive implements ISeriesPrimitive<Time> {
  private _arrows: readonly PeakWallRankArrow[] = [];
  private _rankLimit = 0;
  private _chart: IChartApi | null = null;
  private _series: ISeriesApi<SeriesType> | null = null;
  private _requestUpdate?: () => void;
  private readonly _paneView: PeakWallRankArrowsPaneView;

  constructor() {
    this._paneView = new PeakWallRankArrowsPaneView(this);
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
    // pane view 가 매 draw 에서 source 를 직접 읽는다(형제 primitive 들과 동일).
  }
  paneViews(): readonly IPrimitivePaneView[] {
    return [this._paneView];
  }

  setArrows(arrows: readonly PeakWallRankArrow[], rankLimit: number): void {
    this._arrows = arrows;
    this._rankLimit = rankLimit;
    this._requestUpdate?.();
  }
  arrowsData(): readonly PeakWallRankArrow[] {
    return this._arrows;
  }
  rankLimit(): number {
    return this._rankLimit;
  }
  chartApi(): IChartApi | null {
    return this._chart;
  }
  seriesApi(): ISeriesApi<SeriesType> | null {
    return this._series;
  }
}
