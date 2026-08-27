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
import type { DayBoundaryTick } from './sessionSpans';
import { resolveTokensThemed } from '../util/tokens';

/**
 * 점선 리듬 — DOM 시절 `repeating-linear-gradient(to bottom, color 0 3px,
 * transparent 3px 6px)` 과 같은 3px 칠 / 3px 빔. 값을 바꾸면 눈에 보이는 변경이다.
 */
export const DAY_BOUNDARY_DASH: readonly [number, number] = [3, 3];

/**
 * 선 두께 — **1px 고정**. DESIGN.md 는 hairline 을 px 로 못박는다(density dial 이
 * 굵기를 흔들면 픽셀 격자 정렬이 깨진다). 사용자 설정이 아니라 상수인 이유는
 * 이 모듈 하단 docstring 참조.
 */
export const DAY_BOUNDARY_LINE_WIDTH = 1;

/**
 * 색은 **draw 시점에 지연 해석**한다 — 테마(obsidian/ledger/toss-*) 전환이 그대로
 * 따라온다(`StudySavedRangeBandPrimitive` TOKEN_SPEC 선례).
 *
 * `--chart-day-boundary` 는 이 표시 전용 토큰이다. `--border-strong` ·
 * `--chart-pane-divider` 를 재사용하지 **않는** 이유는 그 계열이 네 테마 모두에서
 * `--bg-card` 대비 1.5~2.1:1 이라 WCAG 1.4.11(비텍스트 3:1)에 못 미치기 때문이다
 * (DESIGN.md 가 스스로 "아직 미해결"로 적어 둔 그룹이다). 실측:
 * `--grid` 1.08~1.19 · `--border-strong` 1.46~2.14 · `--chart-pane-divider` 1.46~2.01.
 * 전용 토큰은 3.04~4.44:1 을 지킨다.
 */
const TOKEN_SPEC = {
  line: ['--chart-day-boundary', '#6d6d7b'],
} as const;

/**
 * 매 프레임 draw 가 읽는 입력. **pull 방식** — 축 스케일은 팬/줌마다 바뀌므로
 * 상위에서 좌표를 미리 구우면 그 시점에 굳는다(`StudySavedRangeBandSnapshot` 선례).
 * 그래서 여기 담기는 건 **좌표가 아니라 시각**이다.
 */
export type DayBoundarySource = () => readonly DayBoundaryTick[] | null;

/** 그릴 자리가 확정된 구분선 — `x` 는 stroke **중심** 좌표다(아래 정렬 규칙 참조). */
export type PlacedBoundary = Readonly<{ date: string; x: number }>;

/**
 * 경계 시각 → pane 로컬 stroke 중심 x. `timeToCoordinate` 를 인자로 받아
 * lightweight-charts 비의존으로 두는 이유는 단위 테스트가 축 스케일을 표로 세우기
 * 위해서다(`computeBandGeometry` 선례).
 *
 * ## 왜 `Math.round(x) + lineWidth / 2` 인가
 *
 * DOM 시절 선은 `translateX(x)` + `width: {lineWidth}px` 였으니 실제로 칠해진
 * 픽셀 구간은 `[x, x + lineWidth)` 다. 캔버스 stroke 는 **중심선** 기준이라 같은
 * 구간을 얻으려면 중심을 `x + lineWidth / 2` 에 둬야 한다. 앞의 `Math.round` 는
 * 그 구간의 시작을 픽셀 격자에 앉혀 흐릿한 반투명 가장자리를 막는다 — 두께가
 * 홀수면 중심이 `.5`, 짝수면 정수로 떨어져 **네 두께 모두** 선명하다.
 *
 * `null` 좌표(축에 없는 시각)는 **버린다** — 0 으로 접으면 구분선이 pane 좌단에
 * 눌어붙는다(`computeBandGeometry` 가 같은 회귀를 막는다).
 *
 * pane 밖으로 나간 선도 버린다. 캔버스가 어차피 자르지만, 화면 밖 세그먼트가
 * 수백 개인 긴 코퍼스에서 path 를 그만큼 아낀다.
 */
export function computeBoundaryLines(
  boundaries: readonly DayBoundaryTick[],
  timeToCoordinate: (virtualSec: number) => number | null,
  lineWidth: number,
  paneWidth: number,
): readonly PlacedBoundary[] {
  const out: PlacedBoundary[] = [];
  for (const b of boundaries) {
    const raw = timeToCoordinate(b.virtualMs / 1000);
    if (raw == null) continue;
    const x = Math.round(raw) + lineWidth / 2;
    if (x < 0 || x > paneWidth) continue;
    out.push({ date: b.date, x });
  }
  return out;
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

class DayBoundaryRenderer implements IPrimitivePaneRenderer {
  private readonly _source: DayBoundaryPrimitive;

  constructor(source: DayBoundaryPrimitive) {
    this._source = source;
  }

  draw(target: CanvasRenderingTarget2D): void {
    const chart = this._source.chartApi();
    const boundaries = this._source.snapshot();
    if (!chart || boundaries === null || boundaries.length === 0) return;

    const read = coordinateReader(chart.timeScale());

    // Media(CSS 픽셀) space — `timeToCoordinate` 와 같은 단위. 캔버스가 pane 자체라
    // mediaSize 가 곧 pane 폭·높이다. DOM 시절 필요했던 pane 박스 클립(#1272:
    // 컨테이너 560.6px vs pane 498px, 거터 62.6px 로 선이 4.9px 침범했다)과
    // z-10(#1238)은 여기서 구조적으로 불필요해진다 — 우측 가격축 거터도 하단
    // 시간축도 애초에 이 캔버스 밖이다.
    target.useMediaCoordinateSpace((scope) => {
      const { width, height } = scope.mediaSize;
      if (width <= 0 || height <= 0) return;

      const placed = computeBoundaryLines(boundaries, read, DAY_BOUNDARY_LINE_WIDTH, width);
      if (placed.length === 0) return;

      const ctx = scope.context;
      ctx.save();
      ctx.setLineDash([...DAY_BOUNDARY_DASH]);
      ctx.strokeStyle = resolveTokensThemed(TOKEN_SPEC).line;
      ctx.lineWidth = DAY_BOUNDARY_LINE_WIDTH;
      // 모든 구분선을 한 path 로 모아 stroke 한 번 — 경계마다 stroke 를 부르면
      // 같은 그림에 상태 전환만 늘어난다.
      ctx.beginPath();
      for (const b of placed) {
        ctx.moveTo(b.x, 0);
        ctx.lineTo(b.x, height);
      }
      ctx.stroke();
      ctx.restore();
    });
  }
}

class DayBoundaryPaneView implements IPrimitivePaneView {
  private readonly _renderer: DayBoundaryRenderer;
  private readonly _zOrder: PrimitivePaneViewZOrder;

  constructor(source: DayBoundaryPrimitive, zOrder: PrimitivePaneViewZOrder) {
    this._renderer = new DayBoundaryRenderer(source);
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
 * 세션 경계마다 세로 점선 하나 — 날짜 라벨은 적응형 x 축이 갖고
 * (`util/kstHorzScaleBehavior`) 이 primitive 는 **선만** 그린다.
 * N 세그먼트 → N-1 경계(첫 세그먼트 앞에는 긋지 않는다).
 *
 * DOM 오버레이가 아니라 primitive 인 이유: DOM 은
 * `subscribeVisibleLogicalRangeChange` → rAF → React 렌더 경로라 캔버스 페인트보다
 * **최소 한 프레임** 늦는다. 그 결과가 팬/줌 중 구분선이 캔들을 뒤따라오는 지연이었다
 * (사용자 신고 2026-08-27). `draw` 는 캔들과 같은 프레임·같은 캔버스 패스에서
 * 호출되므로 지연이 줄어드는 게 아니라 **구조적으로 0** 이 된다
 * (`HighLowLabelsPrimitive` · `StudySavedRangeBandPrimitive` 와 동일 처방).
 *
 * 따라서 **이 계열에 range 구독을 되살리면 지연도 함께 돌아온다** — 팬/줌 재계산은
 * lwc 캔버스 패스가 담당하고, `requestUpdate` 는 오직 **데이터·스타일이 바뀌었을 때**
 * 호스트가 부른다.
 *
 * zOrder 는 `'top'` — DOM 시절 `z-10` 으로 캔버스 위에 올려 두던 것과 시각적으로
 * 같다(`StudySavedRangeBandPrimitive` 와 같은 판단).
 *
 * ## 왜 색·두께가 사용자 설정이 아닌가 (2026-08-27 결정)
 *
 * 종전엔 `dayBoundaryColor`/`dayBoundaryLineWidth` prefs 와 설정 모달의 스타일
 * 피커가 있었다. 그것을 걷어낸 이유는 두 가지다:
 *
 * 1. **날짜 구분선은 격자선과 같은 차트 구조물**이지 사용자가 튜닝할 데이터
 *    레이어가 아니다. 켜고 끄는 토글도 같은 이유로 없앴다(분봉에서 항상 그린다 —
 *    D/W/M 은 한 캔들이 곧 하루라 애초에 그릴 자리가 없다).
 * 2. **색을 고를 자유는 대비 3:1 을 깨뜨릴 자유와 같이 온다.** 종전 기본값
 *    `#64748B` 는 네 테마 모두 3.75~4.76:1 로 멀쩡했지만 그건 우연히 잘 고른
 *    중립값이었고, 피커는 그 보장을 사용자에게 떠넘겼다. 게다가 그 값은 ledger
 *    (따뜻한 종이 팔레트)에서 **차가운 슬레이트 블루로 겉돌았다** — 테마 토큰이
 *    푸는 것이 정확히 이 문제다.
 */
export class DayBoundaryPrimitive implements ISeriesPrimitive<Time> {
  private readonly _source: DayBoundarySource;
  private _chart: IChartApi | null = null;
  private _series: ISeriesApi<SeriesType> | null = null;
  private _requestUpdate?: () => void;
  private readonly _paneView: DayBoundaryPaneView;

  constructor(source: DayBoundarySource, zOrder: PrimitivePaneViewZOrder = 'top') {
    this._source = source;
    this._paneView = new DayBoundaryPaneView(this, zOrder);
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

  /** 데이터/스타일이 바뀌었을 때 host 가 호출 — 팬/줌은 lwc 가 알아서 다시 그린다. */
  requestUpdate(): void {
    this._requestUpdate?.();
  }

  snapshot(): readonly DayBoundaryTick[] | null {
    return this._source();
  }

  chartApi(): IChartApi | null {
    return this._chart;
  }

  seriesApi(): ISeriesApi<SeriesType> | null {
    return this._series;
  }
}
