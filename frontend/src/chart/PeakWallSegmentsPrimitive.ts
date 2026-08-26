import type {
  IChartApi,
  IRange,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  ITimeScaleApi,
  Logical,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import { measureTextCached } from './util/textWidthCache';
import { resolveTokensThemed } from '../util/tokens';
import { ARROW_HEIGHT_PX, drawPeakWallArrow } from './peakWallArrowShape';

// 라벨 칩 표면·테두리 — canvas 는 var(--…) 를 못 받아 지연 해석. 하드코딩 다크
// 반투명이던 것을 테마 표면(불투명)+테두리로: Ledger 라이트에서도 방향색 텍스트가
// 캔들 위에서 또렷하게(반투명 비침 대비 저하 해소). high/low 오버레이와 동일 처방.
const CHIP_TOKENS = {
  bg: ['--bg-card', '#121216'],
  border: ['--border-strong', '#33333C'],
} as const;

/**
 * 거래일별 최대벽을 그날 구간에만 걸치는 수평 세그먼트로 그리는 커스텀 series primitive.
 * **매도·매수 공용**이다 — 방향은 호출자가 넘기는 색과 `PeakWallLabelSide` 로만 갈린다
 * (2026-08-23 개명: 종전 이름 `AskPeakSegmentsPrimitive` 는 매수도 그리면서 매도 이름을
 *  달고 있었다).
 *
 * lwc 기본 price line은 차트 전폭이라 여러 날을 못 그린다. 그래서 surge 마커와 같은 방식으로
 * `timeScale.timeToCoordinate(time)`(x) + series의 `priceToCoordinate(price)`(y)로 직접 그린다 —
 * 각 세그먼트는 [time0, time1] x-구간(그날 open→close, 오늘은 라이브 엣지) × price y에 수평선.
 * series 길이/timeScale index와 무관해 좌측-팬 백필에도 면역(SurgeMarkersPrimitive와 동일 근거).
 */
export interface PeakWallSegment {
  /** 그날 시작 — axis.toVirtual(open)/1000 (가상 초, 라인 점과 동일 좌표계). */
  time0: Time;
  /** 그날 끝 — 과거일=close, 오늘=라이브 엣지(마지막 캔들). */
  time1: Time;
  /** peak이 실제 걸린 시점 — 이 x에 점을 찍어 그 날 언제 최대벽이었는지 표시. */
  peakTime: Time;
  /** 그날 최대벽 가격(priceToCoordinate 입력). */
  price: number;
  /** 비교용 물량. 현재 보이는 영역 내 최대벽 강조 선택에 사용하며 직접 렌더링하지 않는다. */
  qty: number;
  /** 가격·물량 라벨(예: "150,000, 16.5k"). 빈 문자열이면 라벨 생략. */
  label: string;
  color: string;
  lineWidth: number;
  /** 오늘(라이브) 세그먼트 여부(스타일 구분용). */
  live?: boolean;
  /** 수평선을 그리는가. **생략 = 그린다**(구 호출부 호환).
   *  계열별 「수평선 표시」 토글이 여기로 흘러든다. */
  horizontalLine?: boolean;
  /** 발생 시점 화살표를 찍는가. **생략 = 찍는다**.
   *  계열별 「발생 시점 화살표」 토글. 라벨 회피 간격도 이 값을 따라간다 — 화살표가
   *  없는데 비켜 서면 라벨이 빈 공간을 피해 떠 있는 **유령 회피**가 된다. */
  timeMarker?: boolean;
}

/** 세그먼트의 두 표면 플래그를 "생략=켜짐" 규약으로 읽는다. 세 소비처(draw · 도킹 라벨 ·
 *  고저 라벨 회피)가 같은 해석을 쓰도록 한 곳에 둔다. */
export function segmentDrawsHorizontalLine(segment: Pick<PeakWallSegment, 'horizontalLine'>): boolean {
  return segment.horizontalLine !== false;
}
export function segmentDrawsTimeMarker(segment: Pick<PeakWallSegment, 'timeMarker'>): boolean {
  return segment.timeMarker !== false;
}

/** 최대벽 라벨의 측면 — 매도는 선 위, 매수는 선 아래에 붙어 같은 분봉에서 서로 비켜간다. */
export type PeakWallLabelSide = 'ask' | 'bid';

export interface PeakWallDockedLabel {
  price: number;
  label: string;
  color: string;
  /** 그날 세그먼트 양 끝 — 칩을 그날 구간 안에 가두는 경계(이웃 날로 새는 것 방지). */
  time0: Time;
  time1: Time;
  /** peak 발생 시점(봉 버킷에 스냅됨) — 라벨 앵커. 발생 시점 화살표와 같은 x. */
  peakTime: Time;
  side: PeakWallLabelSide;
  /** 이 벽이 발생 시점 화살표를 찍는가 — 칩이 그만큼 비켜설지를 정한다(생략=찍는다). */
  timeMarker?: boolean;
}

type VisibleTimeRange = IRange<Time> | null;

function segmentOverlapsVisibleRange(segment: PeakWallSegment, visibleRange: VisibleTimeRange): boolean {
  if (!visibleRange) return true;
  const visibleFrom = visibleRange.from as unknown as number;
  const visibleTo = visibleRange.to as unknown as number;
  const from = Math.min(visibleFrom, visibleTo);
  const to = Math.max(visibleFrom, visibleTo);
  const s0 = segment.time0 as unknown as number;
  const s1 = segment.time1 as unknown as number;
  return Math.max(Math.min(s0, s1), from) <= Math.min(Math.max(s0, s1), to);
}

/** 중복 제거 키 — **(그날, 가격)**. 선 끝에 도킹하던 시절에는 가격만으로 합쳤지만(같은 가격이면
 *  칩이 한 자리에 겹치므로), 라벨을 **발생 분봉 위**로 옮기면 같은 가격이라도 날마다 x 앵커가 달라
 *  겹치지 않는다. 가격만으로 합치면 다른 날의 벽은 점만 남고 수량을 못 읽는다. 하루 안 여러 가격은
 *  allPriceRankLimit(체결된 벽 개수)이 이미 제한한다. */
function dayPriceKey(segment: PeakWallSegment): string {
  return `${segment.time0 as unknown as number}|${segment.price}`;
}

export function livePeakWallDockedLabelsFromSegments(
  segments: readonly PeakWallSegment[],
  side: PeakWallLabelSide,
  visibleRange: VisibleTimeRange = null,
  rankLimit?: number,
): PeakWallDockedLabel[] {
  // rankLimit === 0 은 "라벨 없음"(줌아웃 예산 0). undefined 는 "전체"(컷 없음).
  if (rankLimit === 0) return [];
  const candidates = segments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => (
      segment.label !== ''
      && (visibleRange ? segmentOverlapsVisibleRange(segment, visibleRange) : segment.live === true)
    ));
  const uniqueByDayPrice = (items: typeof candidates): typeof candidates => {
    const best = new Map<string, typeof candidates[number]>();
    for (const item of items) {
      const key = dayPriceKey(item.segment);
      const previous = best.get(key);
      if (
        !previous
        || item.segment.qty > previous.segment.qty
        || (item.segment.qty === previous.segment.qty && item.index < previous.index)
      ) {
        best.set(key, item);
      }
    }
    return items.filter((item) => best.get(dayPriceKey(item.segment)) === item);
  };
  const uniqueCandidates = uniqueByDayPrice(candidates);
  const rankedCandidates = rankLimit
    ? uniqueCandidates.slice().sort((a, b) => b.segment.qty - a.segment.qty || a.index - b.index)
    : uniqueCandidates;
  const ranked = rankLimit
    ? rankedCandidates.slice(0, rankLimit)
    : rankedCandidates;
  return ranked
    .map(({ segment }) => ({
      price: segment.price,
      label: segment.label,
      color: segment.color,
      time0: segment.time0,
      time1: segment.time1,
      peakTime: segment.peakTime,
      side,
      timeMarker: segmentDrawsTimeMarker(segment),
    }));
}

// 줌(barSpacing) → side별 도킹 라벨 개수 예산. 이 아래로 좁아지면(줌아웃) 라벨을 전부 숨기고,
// 이상이면 barSpacing 에 선형 비례해 MIN~MAX 개만 남긴다(가시범위 내 qty 상위 N). 밀집 방지 +
// "줌인=더 보임" 요청을 한 손잡이로 해결. 픽셀 임계라 DPR/줌과 무관하게 barSpacing 만 본다.
//
// **3.5/16 → 6/33 (2026-08-22)**: 라벨이 「잔량만」에서 「가격, 잔량」으로 돌아가며 칩이
// 넓어졌다. 실측(11px sans-serif, 실제 canvas `measureText`): 텍스트 폭 **평균 2.7배**
// (20.8~33px → 45.3~79.5px), 좌우 패딩 8px 을 더한 **칩 폭 기준 약 2.06배**(~34 → ~70px).
// 겹침은 칩끼리 일어나므로 보정 기준은 칩 폭이다.
//
// RAMP_END 는 그 배율을 그대로 태웠다(16 × 2.06 ≈ 33). barSpacing 12 에서 6개 → 3개가
// 되는데, 칩이 2배이므로 **차지하는 가로 폭은 같다** — 같은 밀도다.
//
// ⚠ HIDE 는 **비례보다 완만하게** 올렸다(3.5 × 2.06 ≈ 7 이 아니라 6). 7 로 두면
// barSpacing 6 대에서 라벨이 **통째로 사라진다** — 최소 2개는 보이는 편이 "안 보인다"
// 보다 낫다는 판단이다. 6 이면 그 구간에서 MIN(2개)이 살아남고, 4px 대(칩 하나가 봉
// 17개를 덮는 폭)에서만 숨는다.
//
// **MAX 는 줄이지 않는다.** 줄이면 줌인해도 못 보게 되어 #839 가 만든 "줌인=더 보임"
// 손잡이가 망가진다. 좁은 줌에서만 더 일찍 감추는 것이 이 조정의 의도다.
export const PEAK_LABEL_HIDE_BAR_SPACING_PX = 6;
export const PEAK_LABEL_BUDGET_RAMP_END_PX = 33;
export const PEAK_LABEL_BUDGET_MIN = 2;
export const PEAK_LABEL_BUDGET_MAX = 8;

export function peakLabelBudgetForBarSpacing(barSpacing: number): number {
  if (!Number.isFinite(barSpacing) || barSpacing < PEAK_LABEL_HIDE_BAR_SPACING_PX) return 0;
  const t = clamp(
    (barSpacing - PEAK_LABEL_HIDE_BAR_SPACING_PX)
      / (PEAK_LABEL_BUDGET_RAMP_END_PX - PEAK_LABEL_HIDE_BAR_SPACING_PX),
    0,
    1,
  );
  return Math.round(PEAK_LABEL_BUDGET_MIN + t * (PEAK_LABEL_BUDGET_MAX - PEAK_LABEL_BUDGET_MIN));
}

export function inlinePeakWallSegmentsForDocking(
  segments: readonly PeakWallSegment[],
): PeakWallSegment[] {
  return segments.map((segment) => (
    segment.label !== ''
      ? { ...segment, label: '' }
      : segment
  ));
}

/** 벽 발생 시점 마커가 선에서 차지하는 두께 — 라벨이 이만큼 비켜난다.
 *
 * 2026-08-26 이전엔 반지름 3.5px 의 **점**이었고 이 값이 그 반지름이었다. 지금은 순위
 * 화살표와 같은 화살표라, 끝이 선에 닿고 몸통이 라벨 쪽(매도=위 · 매수=아래)으로
 * `ARROW_HEIGHT_PX` 만큼 뻗는다. 라벨이 그 몸통을 덮으면 "언제 걸린 벽인지" 가 가려지므로
 * 회피량도 같이 커져야 한다. */
export const PEAK_MARKER_CLEARANCE_PX = ARROW_HEIGHT_PX;
export const LABEL_GAP_PX = 3;
export const LABEL_FONT_PX = 11;
export const LABEL_ROW_GAP_PX = 5;
export const LABEL_EDGE_PAD_PX = 4;
export const LABEL_SEGMENT_PAD_PX = 8;
export const LABEL_BOX_X_PAD_PX = 4;
export const LABEL_BOX_Y_PAD_PX = 1;

export type PeakWallLabelCandidate = {
  index: number;
  xRight: number;
  yLine: number;
  width: number;
  segmentWidth: number;
};

export type PeakWallLabelLayout = PeakWallLabelCandidate & {
  baselineY: number;
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * peak 발생 시점의 x. `timeToCoordinate` 는 그 시각이 로드된 시계열 범위 밖이면 null 을 내므로
 * `[time0, time1]` 내 위치로 선형 보간해 폴백한다(세션 내 가상시각이 x와 단조라 근사 정확).
 *
 * **점(dot)·라벨·고저 라벨 회피 rect 가 반드시 이 함수를 함께 쓴다.** 각자 구하면 폴백이 걸리는
 * 구간에서만 서로 어긋나 — 평소엔 멀쩡하고 특정 날짜/줌에서만 라벨이 점을 떠나는 결함이 된다.
 * 입력 x0/x1 과 rawPeakX 는 **같은 좌표계**여야 한다(bitmap 이면 둘 다 bitmap).
 */
export function peakXFromCoordinate(
  rawPeakX: number | null,
  peakTime: Time,
  time0: Time,
  time1: Time,
  x0: number,
  x1: number,
): number {
  if (rawPeakX !== null && Number.isFinite(rawPeakX)) return rawPeakX;
  const t0 = time0 as unknown as number;
  const t1 = time1 as unknown as number;
  const tp = peakTime as unknown as number;
  const frac = t1 > t0 ? clamp((tp - t0) / (t1 - t0), 0, 1) : 0;
  return x0 + frac * (x1 - x0);
}

export type PeakWallChipGeometryInput = {
  /** 라벨 앵커 — peak 발생 봉의 x(점과 동일). */
  peakX: number;
  /** 그날 세그먼트 양 끝 x. */
  dayX0: number;
  dayX1: number;
  /** 벽 가격선의 y. */
  lineY: number;
  /** 측정된 텍스트 폭(칩 좌우 패딩 제외). */
  textWidth: number;
  side: PeakWallLabelSide;
  paneWidth: number;
  /** 이 벽이 발생 시점 화살표를 찍는가. **생략 = 찍는다**(구 호출부 호환).
   *  끄면 칩이 비켜설 이유가 사라지므로 선 간격이 GAP 만 남는다 — 안 그러면 라벨이
   *  아무것도 없는 자리를 피해 떠 있는 **유령 회피**가 된다. */
  timeMarker?: boolean;
  /** px 상수 → 대상 좌표계 배율. bitmap space 는 hr/vr, media space 는 1(기본). */
  horizontalScale?: number;
  verticalScale?: number;
};

export type PeakWallChipGeometry = {
  /** 우측 정렬 `fillText` 기준 x. */
  xRight: number;
  /** 회피 배치(layoutPeakWallLabels) 이전의 희망 baseline. */
  baselineY: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
};

/**
 * 최대벽 수량 라벨 칩의 기하 — **발생 분봉 위(매도)/아래(매수)** 중앙 정렬.
 *
 * 도킹 렌더러와 고저 극값 라벨의 회피 rect 가 **같은 함수**를 부른다. 예전에는
 * `wallLabelAvoidRect` 가 렌더 기하를 손으로 미러했는데, 그런 미러는 어긋나도 타입 에러가
 * 나지 않아 고저 라벨이 있지도 않은 칩을 피해 표류하는 유령 회피를 낳는다.
 *
 * x 는 ① 발생 봉 중앙 → ② 그날 구간 안 → ③ pane 안 순으로 클램프한다. ②는 구간이 칩보다
 * 넓을 때만 적용한다 — 아침의 오늘 세그먼트는 라이브 엣지까지라 폭이 좁은데, 거기서 숨기면
 * 가장 중요한 라벨이 사라진다(오른쪽은 빈 공간이라 새어도 오독 위험이 없다).
 */
export function peakWallChipGeometry({
  peakX,
  dayX0,
  dayX1,
  lineY,
  textWidth,
  side,
  paneWidth,
  timeMarker = true,
  horizontalScale = 1,
  verticalScale = 1,
}: PeakWallChipGeometryInput): PeakWallChipGeometry | null {
  if (![peakX, dayX0, dayX1, lineY, textWidth, paneWidth].every((n) => Number.isFinite(n))) return null;
  const xPad = LABEL_BOX_X_PAD_PX * horizontalScale;
  const yPad = LABEL_BOX_Y_PAD_PX * verticalScale;
  const edgePad = LABEL_EDGE_PAD_PX * horizontalScale;
  const fontHeight = LABEL_FONT_PX * verticalScale;
  // 발생 시점 마커(화살표)가 차지하는 만큼 더 띄운다 — 라벨이 선 끝이 아니라 그 마커 바로
  // 위/아래에 붙으므로, GAP 만으로는 칩이 마커를 덮어 "언제 걸린 벽인지" 를 가린다.
  // 화살표는 매도=선 위 · 매수=선 아래로 뻗고 라벨도 같은 쪽이라, 한 값으로 양쪽이 맞는다.
  const lineClearance = (LABEL_GAP_PX + (timeMarker ? PEAK_MARKER_CLEARANCE_PX : 0)) * verticalScale;
  const chipWidth = textWidth + xPad * 2;
  const half = chipWidth / 2;

  const dayLeft = Math.min(dayX0, dayX1);
  const dayRight = Math.max(dayX0, dayX1);
  let center = peakX;
  if (dayRight - dayLeft >= chipWidth) center = clamp(center, dayLeft + half, dayRight - half);
  const paneMin = edgePad + half;
  const paneMax = paneWidth - edgePad - half;
  center = paneMax >= paneMin ? clamp(center, paneMin, paneMax) : (paneMin + paneMax) / 2;

  // baseline 은 텍스트 아랫변('bottom'). 매도=칩 아랫변이 선 위, 매수=칩 윗변이 선 아래.
  const baselineY = side === 'ask'
    ? lineY - lineClearance - yPad
    : lineY + lineClearance + fontHeight + yPad;
  const xRight = center + textWidth / 2;
  return {
    xRight,
    baselineY,
    left: xRight - textWidth - xPad,
    right: xRight + xPad,
    top: baselineY - fontHeight - yPad,
    bottom: baselineY + yPad,
  };
}

function labelsOverlap(a: PeakWallLabelLayout, b: PeakWallLabelLayout, rowHeight: number): boolean {
  const aLeft = a.xRight - a.width;
  const bLeft = b.xRight - b.width;
  const xOverlaps = aLeft <= b.xRight && bLeft <= a.xRight;
  const yOverlaps = Math.abs(a.baselineY - b.baselineY) < rowHeight;
  return xOverlaps && yOverlaps;
}

function labelXOverlaps(a: PeakWallLabelLayout, b: PeakWallLabelLayout): boolean {
  const aLeft = a.xRight - a.width;
  const bLeft = b.xRight - b.width;
  return aLeft <= b.xRight && bLeft <= a.xRight;
}

function overlappingLabelGroups(layouts: readonly PeakWallLabelLayout[]): PeakWallLabelLayout[][] {
  const groups: PeakWallLabelLayout[][] = [];
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

export function visiblePeakWallLabelCandidates(
  candidates: readonly PeakWallLabelCandidate[],
  segmentPad: number,
): PeakWallLabelCandidate[] {
  return candidates.filter((candidate) => candidate.segmentWidth >= candidate.width + segmentPad * 2);
}

/**
 * Canvas 라벨은 DOM 레이아웃 도움을 못 받으므로, 같은 화면 영역의 라벨끼리만 baseline을 벌린다.
 * 원래 선 위 위치를 우선하되 겹치면 아래쪽 빈 슬롯으로 내리고, pane 밖으로 나가면 위로 되민다.
 */
export function layoutPeakWallLabels<T extends PeakWallLabelCandidate>(
  candidates: readonly T[],
  minBaselineY: number,
  maxBaselineY: number,
  rowHeight: number,
): (T & { baselineY: number })[] {
  const layouts: (T & { baselineY: number })[] = [];
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

/** 세그먼트 끝점 시각 → x좌표. `timeToCoordinate`는 시각이 로드된 시계열의 첫/마지막
 *  포인트 밖이면 null을 반환하는데, 통합(UN) 확장 세션 경계(08:00/20:00)는 캔들 소스에
 *  따라 실데이터 범위 밖일 수 있어 그날 벽 선 전체가 조용히 사라졌다(2026-07-08 "특정
 *  날짜에만 표시"). null이면 가장 가까운 실데이터 봉 인덱스로 클램프해 그날의 실제 봉
 *  구간만큼 그린다 — peak 점의 보간 폴백과 같은 철학(그릴 수 있으면 항상 그린다). */
export function xCoordinateOrNearest(timeScale: ITimeScaleApi<Time>, time: Time): number | null {
  const x = timeScale.timeToCoordinate(time);
  if (x !== null) return x;
  const nearest = timeScale.timeToIndex(time, true);
  if (nearest === null) return null;
  return timeScale.logicalToCoordinate(nearest as unknown as Logical);
}

class PeakWallSegmentsRenderer implements IPrimitivePaneRenderer {
  private readonly _source: PeakWallSegmentsPrimitive;
  constructor(source: PeakWallSegmentsPrimitive) {
    this._source = source;
  }

  draw(target: CanvasRenderingTarget2D): void {
    const chart = this._source.chartApi();
    const series = this._source.seriesApi();
    if (!chart || !series) return;
    const timeScale = chart.timeScale();
    const segments = this._source.segmentsData();
    if (segments.length === 0) return;
    const side = this._source.labelSide();
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const hr = scope.horizontalPixelRatio;
      const vr = scope.verticalPixelRatio;
      const labelCandidates: PeakWallLabelCandidate[] = [];
      for (let i = 0; i < segments.length; i += 1) {
        const s = segments[i];
        const x0 = xCoordinateOrNearest(timeScale, s.time0);
        const x1 = xCoordinateOrNearest(timeScale, s.time1);
        const y = series.priceToCoordinate(s.price);
        if (x0 === null || x1 === null || y === null) continue;
        const px0 = x0 * hr;
        const px1 = x1 * hr;
        const py = y * vr;
        // 수평 세그먼트 — 계열별 「수평선 표시」 토글을 세그먼트가 실어 온다.
        if (segmentDrawsHorizontalLine(s)) {
          ctx.beginPath();
          ctx.strokeStyle = s.color;
          ctx.lineWidth = Math.max(1, s.lineWidth) * vr;
          ctx.moveTo(px0, py);
          ctx.lineTo(px1, py);
          ctx.stroke();
        }
        // peak 발생 시점 마커(그 날 언제 최대벽이었는지). timeToCoordinate(peakTime)가 정확하지만,
        // peak 시각이 로드된 캔들 범위 밖이면 null을 내 마커가 누락된다(일부만 보이던 버그). 그럴 때는
        // 세그먼트 끝점(x0~x1) 사이를 peakTime의 [time0,time1] 내 위치로 선형 보간해 폴백 — 선이
        // 그려지는 한 마커도 항상 그려진다(보간은 세션 내 가상시각이 x와 단조라 근사 정확).
        const rawPeakX = timeScale.timeToCoordinate(s.peakTime);
        const pxPeak = peakXFromCoordinate(
          rawPeakX === null ? null : rawPeakX * hr,
          s.peakTime,
          s.time0,
          s.time1,
          px0,
          px1,
        );
        // 순위 화살표와 **같은 도형**(`peakWallArrowShape`). 끝이 벽 가격 선에 닿고 몸통은
        // 라벨과 같은 쪽으로 뻗는다 — 매도는 위에서 아래를, 매수는 아래에서 위를 가리킨다.
        //
        // 수평선과 **독립 토글**이다: 선만·화살표만·둘 다·둘 다 끄고 라벨만 — 네 조합이
        // 전부 유효하다(화살표는 벽 가격 y 에 앵커하므로 선 없이도 위치를 말한다).
        if (segmentDrawsTimeMarker(s)) drawPeakWallArrow(ctx, {
          cx: pxPeak,
          tipY: py,
          dir: side === 'ask' ? -1 : 1,
          color: s.color,
          horizontalPixelRatio: hr,
          verticalPixelRatio: vr,
        });
        // 라벨은 선/점 렌더 후 한 번에 배치해 가까운 가격대의 텍스트 겹침을 피한다.
        if (s.label) {
          ctx.font = `${LABEL_FONT_PX * vr}px sans-serif`;
          labelCandidates.push({
            index: i,
            xRight: px1,
            yLine: py - LABEL_GAP_PX * vr,
            width: measureTextCached(ctx, s.label),
            segmentWidth: Math.abs(px1 - px0),
          });
        }
      }
      if (labelCandidates.length === 0) return;
      const rowHeight = (LABEL_FONT_PX + LABEL_ROW_GAP_PX) * vr;
      const minBaselineY = (LABEL_FONT_PX + LABEL_EDGE_PAD_PX) * vr;
      const maxBaselineY = scope.bitmapSize.height - LABEL_EDGE_PAD_PX * vr;
      const visibleLabels = visiblePeakWallLabelCandidates(labelCandidates, LABEL_SEGMENT_PAD_PX * hr);
      const labelLayouts = layoutPeakWallLabels(visibleLabels, minBaselineY, maxBaselineY, rowHeight);
      // 칩은 외곽선 없이 표면(fill)만 — 방향색 텍스트가 캔들 위에서 또렷하도록 배경만 깐다.
      const { bg: chipBg } = resolveTokensThemed(CHIP_TOKENS);
      for (const layout of labelLayouts) {
        const s = segments[layout.index];
        ctx.font = `${LABEL_FONT_PX * vr}px sans-serif`;
        const xPad = LABEL_BOX_X_PAD_PX * hr;
        const yPad = LABEL_BOX_Y_PAD_PX * vr;
        const fontHeight = LABEL_FONT_PX * vr;
        const bx = layout.xRight - layout.width - xPad;
        const by = layout.baselineY - fontHeight - yPad;
        const bw = layout.width + xPad * 2;
        const bh = fontHeight + yPad * 2;
        ctx.fillStyle = chipBg;
        ctx.fillRect(bx, by, bw, bh);
        ctx.fillStyle = s.color;
        ctx.textBaseline = 'bottom';
        ctx.textAlign = 'right';
        ctx.fillText(s.label, layout.xRight, layout.baselineY);
      }
    });
  }
}

class PeakWallSegmentsPaneView implements IPrimitivePaneView {
  private readonly _renderer: PeakWallSegmentsRenderer;
  constructor(source: PeakWallSegmentsPrimitive) {
    this._renderer = new PeakWallSegmentsRenderer(source);
  }
  renderer(): IPrimitivePaneRenderer {
    return this._renderer;
  }
}

export class PeakWallSegmentsPrimitive implements ISeriesPrimitive<Time> {
  private _segments: readonly PeakWallSegment[] = [];
  private _chart: IChartApi | null = null;
  private _series: ISeriesApi<SeriesType> | null = null;
  private _requestUpdate?: () => void;
  private readonly _paneView: PeakWallSegmentsPaneView;
  private readonly _side: PeakWallLabelSide;

  /** `side` 는 **발생 시점 화살표의 방향**을 정한다(매도=아래를 가리킴 · 매수=위).
   *  세그먼트마다가 아니라 인스턴스마다인 이유: 이 primitive 는 `LivePeakWallSegments`
   *  가 방향별로 마운트하므로 한 인스턴스의 세그먼트는 전부 같은 방향이다. */
  constructor(side: PeakWallLabelSide = 'ask') {
    this._side = side;
    this._paneView = new PeakWallSegmentsPaneView(this);
  }

  labelSide(): PeakWallLabelSide {
    return this._side;
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

  setSegments(segments: readonly PeakWallSegment[]): void {
    this._segments = segments;
    this._requestUpdate?.();
  }
  segmentsData(): readonly PeakWallSegment[] {
    return this._segments;
  }
  chartApi(): IChartApi | null {
    return this._chart;
  }
  seriesApi(): ISeriesApi<SeriesType> | null {
    return this._series;
  }
}
