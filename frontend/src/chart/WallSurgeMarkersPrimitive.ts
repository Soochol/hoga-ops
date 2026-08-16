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
 *
 * ⚠ 그 "상위 N" 은 **화면에 든 것 중** 상위 N 이다. 로드된 전 기간에서 고르면 설정한
 * 개수와 눈에 보이는 개수가 어긋난다 — 5거래일을 로드하고 하루만 보면 상위 4건이 다른
 * 날에 몰려 화면엔 한 개도 안 뜬다(실측). 라벨을 제한하는 이유가 **화면 위 충돌**이므로
 * 기준도 화면이어야 한다. 그래서 선정이 build 단계가 아니라 여기(draw)에 있다 — 팬·줌
 * 마다 draw 가 다시 도니 별도 구독 없이 따라온다.
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
  /** 라벨 우선순위(증가량). 화면 안 마커끼리 겨룬다. */
  jump: number;
  /** 라벨 문구. **선정된 것만** 그려지므로 전건에 채워 보낸다. */
  label: string;
}

/**
 * 화면에 든 마커(`visible`) 중 증가량 상위 `labelCount` 건의 인덱스.
 *
 * 동점은 `time` 오름차순으로 가른다 — 팬 중 같은 두 마커가 프레임마다 자리를 바꾸면
 * 라벨이 깜빡인다. 입력 순서는 건드리지 않는다(호출부가 인덱스로 되찾는다).
 */
export function pickLabelledIndices(
  markers: readonly WallSurgeMarkerPoint[],
  visible: readonly number[],
  labelCount: number,
): Set<number> {
  if (labelCount <= 0) return new Set();
  if (visible.length <= labelCount) return new Set(visible);
  return new Set(
    [...visible]
      .sort((a, b) => {
        const d = markers[b].jump - markers[a].jump;
        return d !== 0 ? d : Number(markers[a].time) - Number(markers[b].time);
      })
      .slice(0, labelCount),
  );
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

function clamp(v: number, lo: number, hi: number): number {
  return hi < lo ? lo : Math.min(Math.max(v, lo), hi);
}

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

      // 1패스 — 좌표를 잡고 **화면 밖을 떨군다**. `timeToCoordinate` 의 null 은 축
      // 밖이라는 뜻이지 화면 밖이라는 뜻이 아니라(가시 범위 밖도 좌표가 나온다),
      // 캔버스 경계로 직접 판정해야 라벨 자리를 안 보이는 마커에 뺏기지 않는다.
      const placed = new Map<number, { cx: number; cy: number }>();
      const visible: number[] = [];
      markers.forEach((m, i) => {
        const x = timeScale.timeToCoordinate(m.time);
        const y = series.priceToCoordinate(m.price);
        if (x === null || y === null) return;
        const cx = x * hr;
        const cy = y * vr;
        if (cx < 0 || cx > scope.bitmapSize.width) return;
        if (cy < 0 || cy > scope.bitmapSize.height) return;
        placed.set(i, { cx, cy });
        visible.push(i);
      });

      // 2패스 — 화면 안에서만 라벨을 겨루고 그린다.
      const labelled = pickLabelledIndices(markers, visible, this._source.labelCount());

      for (const i of visible) {
        const m = markers[i];
        const { cx, cy } = placed.get(i)!;
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

        // `label` 은 전건에 차 있다 — 게이트는 **선정 여부**다.
        if (labelled.has(i)) {
          this._drawLabel(ctx, m, cx, baseY, hr, vr, sideColor, t, scope.bitmapSize.height);
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
    paneHeight: number,
  ): void {
    const font = LABEL_FONT_PX * vr;
    ctx.save();
    ctx.font = `${font}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(m.label).width;
    const padX = LABEL_BOX_X_PAD_PX * hr;
    const padY = LABEL_BOX_Y_PAD_PX * vr;
    // 삼각형 몸통 바깥쪽에 칩을 붙인다 — 매도는 더 위로, 매수는 더 아래로.
    // 다만 pane 경계를 넘으면 **안쪽으로 물린다**: 최저가 근처 매수벽은 칩이 아래로
    // 밀려 통째로 잘리는데, 그러면 "라벨 N 개" 약속이 개수부터 어긋난다
    // (`AskPeakSegmentsPrimitive` 의 `maxBaselineY` 와 같은 이유·같은 처방).
    const half = font / 2 + padY;
    const chipCy = clamp(
      m.side === 'ask' ? baseY - font : baseY + font,
      half,
      paneHeight - half,
    );
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
    ctx.fillText(m.label, cx, chipCy);
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
  private _labelCount = 0;
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

  setData(markers: readonly WallSurgeMarkerPoint[], labelCount = 0): void {
    this._markers = markers;
    this._labelCount = labelCount;
    this._requestUpdate?.();
  }

  labelCount(): number {
    return this._labelCount;
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
