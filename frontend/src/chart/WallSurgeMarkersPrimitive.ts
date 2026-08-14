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
import { resolveTokensThemed } from '../util/tokens';
// 라벨 칩 치수는 매도벽 라벨과 **같은 상수를 쓴다** — 두 마커가 같은 pane 에 붙으므로
// 칩 크기가 갈리면 한눈에 어긋나 보인다.
import {
  LABEL_BOX_X_PAD_PX,
  LABEL_BOX_Y_PAD_PX,
  LABEL_FONT_PX,
} from './AskPeakSegmentsPrimitive';

/**
 * 호가벽 급증 마커 — 캔들 pane 위, **벽이 선 가격에** 삼각형으로 찍는다.
 *
 * 문법은 설계 문서 §4.2 에서 확정했다. 유형 3 × 결말 4 × 측 2 = 24가지를 색으로 다
 * 표현하면 읽을 수 없어서, 축마다 **다른 시각 채널**을 쓴다:
 *
 *   측    방향 + 색   매도 ▼ `--qty-ask` · 매수 ▲ `--qty-bid`
 *   결말  채움        소화·돌파 = 채움 · 취소 = 외곽선 · 잔존 = 반투명 · 미정 = 회색 외곽선
 *   유형  테두리      재등장 = 점선 (시점이 부정확하다는 표시)
 *
 * ⚠ lwc 기본 `createSeriesMarkers` 를 쓰지 않는 이유는 `SurgeMarkersPrimitive` 주석과
 * 같다 — 기본 마커는 위치를 공유 timeScale 의 logical index 로 잡아, 시리즈 길이가
 * 다르면 마커가 시리즈 끝 너머로 밀린다. 여기서는 `timeToCoordinate`(x) +
 * `priceToCoordinate`(y) 로 직접 배치해 길이 불일치에 면역이다.
 *
 * 라벨은 **상위 몇 건만** 들고 나머지는 마커만 찍는다(호버 툴팁이 나머지를 맡는다).
 * 당일 최대벽은 전건 라벨을 달지만 그건 선분이 몇 개일 때 얘기고, 하루 수십 건이
 * 겹치면 라벨끼리 충돌한다.
 */
export interface WallSurgeMarkerPoint {
  /** axis 가상시(초) — 캔들 버킷에 스냅된 값이어야 마커가 1캔들 밀리지 않는다. */
  time: Time;
  /** 벽이 선 가격. priceToCoordinate 의 입력. */
  price: number;
  side: 'ask' | 'bid';
  /** 채움을 정한다. null 이면 결말 미정. */
  outcome: 'consumed' | 'broken' | 'pulled' | 'held' | null;
  /** 재등장이면 점선 테두리. */
  reappear: boolean;
  /** 있으면 마커 옆에 상시 표시(상위 몇 건만 채워 보낸다). */
  label?: string;
}

const TOKENS = {
  ask: ['--qty-ask', '#3485FA'],
  bid: ['--qty-bid', '#F04452'],
  undecided: ['--text-secondary', '#8A8A94'],
  chipBg: ['--bg-card', '#121216'],
  chipBorder: ['--border-strong', '#33333C'],
} as const;

const HALF_W_PX = 5; // 삼각형 반너비
const HEIGHT_PX = 8; // 삼각형 높이
const GAP_PX = 3; // 가격선과 삼각형 꼭짓점 사이
const HELD_ALPHA = 0.4;

/** 결말별 채움/외곽선 결정 — 색은 측이 정하고 여기서는 **채우는지 여부**만 정한다. */
function fillStyleFor(
  outcome: WallSurgeMarkerPoint['outcome'],
  sideColor: string,
  undecidedColor: string,
): { fill: string | null; stroke: string; alpha: number } {
  if (outcome === null) return { fill: null, stroke: undecidedColor, alpha: 1 };
  if (outcome === 'consumed' || outcome === 'broken') {
    return { fill: sideColor, stroke: sideColor, alpha: 1 };
  }
  if (outcome === 'pulled') return { fill: null, stroke: sideColor, alpha: 1 };
  return { fill: sideColor, stroke: sideColor, alpha: HELD_ALPHA }; // held
}

class WallSurgeMarkersRenderer implements IPrimitivePaneRenderer {
  private readonly _source: WallSurgeMarkersPrimitive;

  constructor(source: WallSurgeMarkersPrimitive) {
    this._source = source;
  }

  draw(target: CanvasRenderingTarget2D): void {
    const chart = this._source.chartApi();
    const series = this._source.seriesApi();
    const markers = this._source.markersData();
    if (!chart || !series || markers.length === 0) return;
    const t = resolveTokensThemed(TOKENS);

    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const hr = scope.horizontalPixelRatio;
      const vr = scope.verticalPixelRatio;
      const timeScale = chart.timeScale();
      const halfW = HALF_W_PX * hr;
      const height = HEIGHT_PX * vr;
      const gap = GAP_PX * vr;

      for (const m of markers) {
        const x = timeScale.timeToCoordinate(m.time);
        const y = series.priceToCoordinate(m.price);
        if (x === null || y === null) continue;
        const cx = x * hr;
        const cy = y * vr;
        const sideColor = m.side === 'ask' ? t.ask : t.bid;
        const { fill, stroke, alpha } = fillStyleFor(m.outcome, sideColor, t.undecided);

        // 매도벽은 아래를 가리키고(위에서 누르는 압력), 매수벽은 위를 가리킨다.
        // 꼭짓점이 그 가격에 닿고 몸통이 반대쪽으로 뻗는다.
        const tipY = m.side === 'ask' ? cy - gap : cy + gap;
        const baseY = m.side === 'ask' ? tipY - height : tipY + height;

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.moveTo(cx, tipY);
        ctx.lineTo(cx - halfW, baseY);
        ctx.lineTo(cx + halfW, baseY);
        ctx.closePath();
        if (fill !== null) {
          ctx.fillStyle = fill;
          ctx.fill();
        }
        // 재등장은 점선 테두리 — 크기는 맞지만 **시점이 부정확**하다는 표시다.
        ctx.setLineDash(m.reappear ? [2 * hr, 2 * hr] : []);
        ctx.lineWidth = Math.max(1, 1.4 * hr);
        ctx.strokeStyle = stroke;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();

        if (m.label) {
          this._drawLabel(ctx, m, cx, baseY, hr, vr, sideColor, t);
        }
      }
    });
  }

  private _drawLabel(
    ctx: CanvasRenderingContext2D,
    m: WallSurgeMarkerPoint,
    cx: number,
    baseY: number,
    hr: number,
    vr: number,
    sideColor: string,
    t: Record<string, string>,
  ): void {
    const font = LABEL_FONT_PX * vr;
    ctx.save();
    ctx.font = `${font}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(m.label!).width;
    const padX = LABEL_BOX_X_PAD_PX * hr;
    const padY = LABEL_BOX_Y_PAD_PX * vr;
    // 삼각형 몸통 바깥쪽에 칩을 붙인다 — 매도는 더 위로, 매수는 더 아래로.
    const chipCy = m.side === 'ask' ? baseY - font : baseY + font;
    ctx.fillStyle = t.chipBg;
    ctx.strokeStyle = t.chipBorder;
    ctx.lineWidth = Math.max(1, hr);
    const chipX = cx - w / 2 - padX;
    const chipY = chipCy - font / 2 - padY;
    ctx.beginPath();
    ctx.rect(chipX, chipY, w + padX * 2, font + padY * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = sideColor;
    ctx.fillText(m.label!, cx, chipCy);
    ctx.restore();
  }
}

class WallSurgeMarkersPaneView implements IPrimitivePaneView {
  private readonly _renderer: WallSurgeMarkersRenderer;

  constructor(source: WallSurgeMarkersPrimitive) {
    this._renderer = new WallSurgeMarkersRenderer(source);
  }

  renderer(): IPrimitivePaneRenderer {
    return this._renderer;
  }
}

export class WallSurgeMarkersPrimitive implements ISeriesPrimitive<Time> {
  private _chart: IChartApi | null = null;
  private _series: ISeriesApi<SeriesType> | null = null;
  private _markers: readonly WallSurgeMarkerPoint[] = [];
  private readonly _paneViews: WallSurgeMarkersPaneView[];
  private _requestUpdate?: () => void;

  constructor() {
    this._paneViews = [new WallSurgeMarkersPaneView(this)];
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

  setData(markers: readonly WallSurgeMarkerPoint[]): void {
    this._markers = markers;
    this._requestUpdate?.();
  }

  chartApi(): IChartApi | null {
    return this._chart;
  }

  seriesApi(): ISeriesApi<SeriesType> | null {
    return this._series;
  }

  markersData(): readonly WallSurgeMarkerPoint[] {
    return this._markers;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this._paneViews;
  }
}
