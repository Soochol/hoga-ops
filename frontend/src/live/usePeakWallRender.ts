// 당일 최대벽의 **단일 렌더 소스** — 한 방향(side)의 「그려질 세그먼트 + 무엇이 그려지는가」를
// 한 번 계산해 모든 표면이 나눠 쓴다.
//
// ## 왜
//
// 종전엔 같은 계산이 **여섯 곳**에서 각자 돌았다(선 오버레이 2 · 도킹 라벨 2 · 고저 라벨
// 회피 2). 그리고 「이 지표가 지금 그려지는가」가 **네 가지 표기**로 손으로 적혀 있었다.
// 넷이 우연히 일치했을 뿐 일치를 강제하는 것이 없었고, 실제로 하나가 어긋나 있었다:
//
//   **회피 경로만 `allPriceRankLimit` 을 안 넘겨 기본값 1 로 돌고 있었다.**
//   「체결된 벽 표시 개수」를 2·3 으로 둔 사용자는 그날 2·3번째 벽이 그려지는데도 고저 극값
//   라벨이 그것들을 피하지 않았다. 인자 하나가 빠진 것이라 타입이 못 잡는다 — 호출부가
//   여섯이면 이런 누락은 **언젠가 반드시 생긴다.**
//
// 그래서 계산과 게이트를 여기 한 곳에 둔다. 표면은 자기 몫의 플래그만 읽는다.
//
// ## 세그먼트는 `enabled` 기준으로만 계산한다 (⚠ 불변식)
//
// 눈(hidden)으로 숨겨도 **레전드는 값을 유지해야 한다**(MA 의 "hide 는 선만 숨긴다" 규칙).
// 그래서 `segments` 는 `hidden` 을 안 본다. 무엇이 실제로 그려지는지는 `drawn`/`labels`/
// `arrows` 플래그가 말한다. 이 분리가 깨지면 눈을 끄는 순간 레전드가 비어 버린다 —
// 이 리포가 red-check 으로 두 번 확인한 규칙이다.

import { useMemo } from 'react';
import type { Candle, RangeSegment } from '../api/types';
import type { VirtualAxis } from '../util/virtualAxis';
import type { PeakWallLabelSide, PeakWallSegment } from '../chart/PeakWallSegmentsPrimitive';
import { useActivePrefs } from '../state/chartPrefs';
import { useWindowIndicator } from './workspace/windowView';
import { buildPeakWallOverlaySegments, toPeakRankLimit, type PeakWallInput } from './peakWallSegments';
import { usePeakMaFilter } from './peakWallMaFilter';
import type { PeakDailyMaFilter } from './peakWallDailyMaFilter';
import type { VisibleTimeCutoff } from './peakWallVisibleCutoff';

export type PeakWallRenderState = {
  /** 필터를 모두 통과한 세그먼트. **`enabled` 기준으로만** 계산한다(위 불변식 참조). */
  segments: readonly PeakWallSegment[];
  /** 선이 실제로 그려지는가 — 「지금 그려지는가」의 **단일 정의**. */
  drawn: boolean;
  /** 도킹 라벨이 그려지는가. */
  labels: boolean;
  /** 순위 화살표가 그려지는가. */
  arrows: boolean;
  /** 선 색·두께(표면이 primitive 에 그대로 넘긴다). */
  color: string;
  lineWidth: number;
  /** 최대벽 강도 pane 의 계단 입력 — **「표시 개수」와 분리해 항상 top-3** 로 계산한
   *  세그먼트. 계단의 뜻은 "그 시점까지 체결된 벽 중 최대" 의 running max 라, 표시
   *  개수 1 로 자르면 그날 1등 벽이 선 시점 이전의 갱신 이력(더 이른 2·3등)이 통째로
   *  사라진다 — 오전에 선이 없다가 오후에 생기는 주 원인이었다(사용자 보고).
   *  필터(MA·시간 컷오프·intraMax)는 그리기 세그먼트와 동일하게 흐른다.
   *  표시 개수가 이미 3 이면 `segments` 와 **같은 참조**다(중복 계산 없음). */
  stepSegments: readonly PeakWallSegment[];
};

type Args = {
  side: PeakWallLabelSide;
  /** 이 방향의 거래일별 최대벽(`LiveChartRoot` 의 cutoff-aware 재계산 결과). */
  peaks: readonly PeakWallInput[];
  segments: readonly RangeSegment[];
  candles: readonly Candle[];
  axis: VirtualAxis;
  todayKst: string;
  /** 분봉 + 캔들 번들이 있는가. false 면 계산하지 않는다(지표가 분봉 전용). */
  applicable: boolean;
  visibleTimeCutoff: VisibleTimeCutoff | null;
  /** 일봉 MA 필터 — 데이터 fetch 가 걸린 훅이라 `LiveChartRoot` 가 한 번 계산해 넘긴다. */
  dailyMaFilter: PeakDailyMaFilter | null;
  /** 최대벽 강도 pane 이 켜져 있을 때만 true — 꺼져 있으면 top-3 재계산을 건너뛴다. */
  needStepSegments?: boolean;
};

/** 빈 상태는 **공유 상수**여야 memo 결과가 참조로 안정된다(빈 배열 리터럴은 매번 새 참조). */
const EMPTY_SEGMENTS: readonly PeakWallSegment[] = [];

export function usePeakWallRender({
  side,
  peaks,
  segments,
  candles,
  axis,
  todayKst,
  applicable,
  visibleTimeCutoff,
  dailyMaFilter,
  needStepSegments = false,
}: Args): PeakWallRenderState {
  const isAsk = side === 'ask';
  const enabled = useWindowIndicator((s) => (isAsk ? s.askPeakEnabled : s.bidPeakEnabled));
  const hidden = useWindowIndicator((s) => (isAsk ? s.askPeakHidden : s.bidPeakHidden));
  const color = useWindowIndicator((s) => (isAsk ? s.askPeakColor : s.bidPeakColor));
  const lineWidth = useWindowIndicator((s) => (isAsk ? s.askPeakLineWidth : s.bidPeakLineWidth));
  const intraMax = useActivePrefs((s) => (isAsk ? s.askPeakIntraMax : s.bidPeakIntraMax));
  const allPriceRankLimit = useActivePrefs(
    (s) => (isAsk ? s.askPeakAllPriceRankLimit : s.bidPeakAllPriceRankLimit),
  );
  const labelEnabled = useActivePrefs(
    (s) => (isAsk ? s.askPeakLabelEnabled : s.bidPeakLabelEnabled),
  );
  const rankArrowEnabled = useActivePrefs(
    (s) => (isAsk ? s.askPeakRankArrowEnabled : s.bidPeakRankArrowEnabled),
  );
  const maFilter = usePeakMaFilter(side);

  const built = useMemo(() => (
    applicable && enabled
      ? buildPeakWallOverlaySegments({
        peaks,
        segments,
        candles,
        axis,
        todayKst,
        baselineStyle: { color, lineWidth },
        intraMax,
        allPriceRankLimit: toPeakRankLimit(allPriceRankLimit),
        visibleTimeCutoff,
        maFilter,
        dailyMaFilter,
      })
      : EMPTY_SEGMENTS
  ), [
    allPriceRankLimit,
    applicable,
    axis,
    candles,
    color,
    dailyMaFilter,
    enabled,
    intraMax,
    lineWidth,
    maFilter,
    peaks,
    segments,
    todayKst,
    visibleTimeCutoff,
  ]);

  // 계단 입력 — 표시 개수와 분리해 항상 top-3. 사용자 표시 개수가 이미 3 이면 위
  // `built` 와 같은 결과이므로 참조를 공유한다(이 memo 는 그때 계산하지 않는다).
  const stepBuilt = useMemo(() => (
    needStepSegments && applicable && enabled && toPeakRankLimit(allPriceRankLimit) !== 3
      ? buildPeakWallOverlaySegments({
        peaks,
        segments,
        candles,
        axis,
        todayKst,
        baselineStyle: { color, lineWidth },
        intraMax,
        allPriceRankLimit: 3,
        visibleTimeCutoff,
        maFilter,
        dailyMaFilter,
      })
      : null
  ), [
    needStepSegments,
    allPriceRankLimit,
    applicable,
    axis,
    candles,
    color,
    dailyMaFilter,
    enabled,
    intraMax,
    lineWidth,
    maFilter,
    peaks,
    segments,
    todayKst,
    visibleTimeCutoff,
  ]);

  const drawn = enabled && !hidden;
  return useMemo(() => ({
    segments: built,
    drawn,
    labels: drawn && labelEnabled,
    arrows: drawn && rankArrowEnabled,
    color,
    lineWidth,
    stepSegments: stepBuilt ?? built,
  }), [built, stepBuilt, color, drawn, labelEnabled, lineWidth, rankArrowEnabled]);
}
