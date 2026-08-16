import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  ITimeScaleApi,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { VirtualAxis } from '../util/virtualAxis';
import type { StudySavedRangeMarks } from '../studyViews/studyDailyContext';
import { resolveTokensThemed } from '../util/tokens';

// draw 에서 지연 해석 — 테마(Obsidian/Ledger) 전환 시 밴드 색이 따라온다
// (HighLowLabelsPrimitive TOKEN_SPEC 선례).
const TOKEN_SPEC = {
  fill: ['--tint-selection', 'rgba(49, 130, 246, 0.10)'],
  edge: ['--accent', '#3182f6'],
} as const;

/**
 * 매 프레임 draw 가 읽는 입력. **pull 방식** — 축 스케일은 팬/줌마다 바뀌므로
 * 상위에서 좌표를 미리 구우면 그 시점에 굳는다(HighLowLabelsSnapshot 선례).
 */
export type StudySavedRangeBandSnapshot = {
  axis: VirtualAxis;
  marks: StudySavedRangeMarks;
};

export type StudySavedRangeBandSource = () => StudySavedRangeBandSnapshot | null;

export type BandGeometry = { left: number; right: number; width: number };

/**
 * 저장 구간 마크(실 ms) → pane 로컬 x 좌표. 마크는 이미 캔들 ts 에 스냅돼 있으므로
 * (`studySavedRangeMarks`) 여기서는 축에 태운 뒤 바 폭의 절반씩 바깥으로 넓혀
 * 밴드 경계를 만든다 — 캔들 몸통의 좌우 끝에 맞추기 위함이다.
 *
 * `timeToCoordinate` 를 인자로 받는 이유: lightweight-charts 비의존으로 두어야
 * 단위 테스트가 축 스케일을 표로 세울 수 있다(`computeVisibleExtremes` 선례).
 *
 * null 반환 = 축이 아직 안 섰거나 구간이 통째로 화면 밖(lwc 가 null 을 준 경우).
 * **null 을 0 으로 접으면 밴드가 차트 좌단에 눌어붙는다** — 그 회귀를 여기서 막는다.
 */
export function computeBandGeometry(
  marks: StudySavedRangeMarks,
  axis: VirtualAxis,
  timeToCoordinate: (virtualSec: number) => number | null,
  barSpacing: number,
): BandGeometry | null {
  const half = Math.max(1, barSpacing / 2);
  const xFrom = timeToCoordinate(axis.toVirtual(marks.fromMs) / 1000);
  const xTo = timeToCoordinate(axis.toVirtual(marks.toMs) / 1000);
  if (xFrom == null || xTo == null) return null;
  const left = xFrom - half;
  const right = xTo + half;
  return { left, right, width: Math.max(0, right - left) };
}

/** 축 좌표 조회 — 차트 teardown 중엔 throw 하므로 null 로 접는다. */
function coordinateReader(ts: ITimeScaleApi<Time>): (virtualSec: number) => number | null {
  return (virtualSec) => {
    try {
      const x = ts.timeToCoordinate(virtualSec as Time);
      return x == null ? null : Number(x);
    } catch {
      return null;
    }
  };
}

class StudySavedRangeBandRenderer implements IPrimitivePaneRenderer {
  private readonly _source: StudySavedRangeBandPrimitive;

  constructor(source: StudySavedRangeBandPrimitive) {
    this._source = source;
  }

  draw(target: CanvasRenderingTarget2D): void {
    const chart = this._source.chartApi();
    const snap = this._source.snapshot();
    if (!chart || snap === null) return;

    const ts = chart.timeScale();
    let barSpacing: number;
    try {
      barSpacing = ts.options().barSpacing ?? 6;
    } catch {
      return;
    }
    const geom = computeBandGeometry(snap.marks, snap.axis, coordinateReader(ts), barSpacing);
    if (geom === null) return;

    // Media(CSS 픽셀) space — timeToCoordinate 와 같은 단위. 캔버스가 캔들 pane
    // 자체라 mediaSize 가 곧 pane 폭·높이다. DOM 시절 필요했던 pane 박스 클립
    // (#1272)과 z-10(#1238)은 여기서 구조적으로 불필요해진다 — 가격축·시간축
    // 거터는 애초에 이 캔버스 밖이다.
    target.useMediaCoordinateSpace((scope) => {
      const ctx = scope.context;
      const paneHeight = scope.mediaSize.height;
      if (scope.mediaSize.width <= 0 || paneHeight <= 0) return;

      const tokens = resolveTokensThemed(TOKEN_SPEC);
      ctx.save();

      if (geom.width > 0) {
        ctx.fillStyle = tokens.fill;
        ctx.fillRect(geom.left, 0, geom.width, paneHeight);
      }

      // 양끝 1px 실선. 0.5 오프셋으로 픽셀 격자에 앉혀 흐릿함을 막는다.
      ctx.fillStyle = tokens.edge;
      ctx.fillRect(Math.round(geom.left), 0, 1, paneHeight);
      ctx.fillRect(Math.round(geom.right), 0, 1, paneHeight);

      ctx.restore();
    });
  }
}

class StudySavedRangeBandPaneView implements IPrimitivePaneView {
  private readonly _renderer: StudySavedRangeBandRenderer;
  private readonly _zOrder: PrimitivePaneViewZOrder;

  constructor(source: StudySavedRangeBandPrimitive, zOrder: PrimitivePaneViewZOrder) {
    this._renderer = new StudySavedRangeBandRenderer(source);
    this._zOrder = zOrder;
  }

  renderer(): IPrimitivePaneRenderer {
    return this._renderer;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return this._zOrder;
  }
}

/**
 * `/study` 캘린더 봉의 **저장 구간 밴드** — accent 계열 tint + 양끝 실선.
 * 넓힌 맥락 창(`studyDailyContext`) 안에서 "이 복기뷰가 저장한 구간이 어디인지" 를
 * 답하는 유일한 표시다. **글자는 얹지 않는다** — 저장 봉·날짜를 적던 상단 라벨은
 * 2026-08-11 사용자 요청으로 걷어냈고(캔들을 가린다), 그 정보는 탭 제목과 저장뷰
 * 드로어에 남아 있다.
 *
 * DOM 오버레이가 아니라 primitive 인 이유: DOM 은
 * `subscribeVisibleLogicalRangeChange` → rAF → React 렌더 경로라 캔버스 페인트보다
 * 최소 한 프레임 늦는다. 그 결과가 팬 중 밴드가 캔들을 뒤따라오는 지연이었다.
 * `draw` 는 캔들과 같은 프레임·같은 캔버스 패스에서 호출되어 지연이 구조적으로
 * 0이 된다(`HighLowLabelsPrimitive` 와 동일 처방).
 *
 * zOrder 는 `'top'` — DOM 시절 `z-10` 으로 캔버스 위에 올려 두던 것과 시각적으로
 * 같다(#1238 에서 캔들 뒤로 숨는 것을 고친 결과였다).
 */
export class StudySavedRangeBandPrimitive implements ISeriesPrimitive<Time> {
  private readonly _source: StudySavedRangeBandSource;
  private _chart: IChartApi | null = null;
  private _series: ISeriesApi<SeriesType> | null = null;
  private _requestUpdate?: () => void;
  private readonly _paneView: StudySavedRangeBandPaneView;

  constructor(source: StudySavedRangeBandSource, zOrder: PrimitivePaneViewZOrder = 'top') {
    this._source = source;
    this._paneView = new StudySavedRangeBandPaneView(this, zOrder);
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

  /** 데이터/축이 바뀌었을 때 host 가 호출 — 팬/줌은 lwc 가 알아서 다시 그린다. */
  requestUpdate(): void {
    this._requestUpdate?.();
  }

  snapshot(): StudySavedRangeBandSnapshot | null {
    return this._source();
  }

  chartApi(): IChartApi | null {
    return this._chart;
  }

  seriesApi(): ISeriesApi<SeriesType> | null {
    return this._series;
  }
}
