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
import {
  buildPeakWallOverlaySegments,
  toAllWallPeakInputs,
  toPeakRankLimit,
  toUnreachedWallPeakInputs,
  type PeakWallInput,
} from './peakWallSegments';
import { mergePeakWallRankSegments } from './peakWallVisibleRanking';
import { usePeakMaFilter } from './peakWallMaFilter';
import type { PeakDailyMaFilter } from './peakWallDailyMaFilter';

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
  /** 최대벽 강도 pane 의 계단 입력 — 「표시 개수」와 분리한 **stepHistory 모드**:
   *  후보 = 기록 갱신 시퀀스(traded_record_*) ∪ top-3, 랭크 슬라이스 없음. 계단의
   *  뜻은 "그 시점까지 체결된 벽 중 최대" 의 running max 인데, top-3 은 최종
   *  크기순이라 벽이 장중에 커지는 날은 오전 기록이 전부 잘렸다(사용자 보고 2회).
   *  필터(MA·시간 컷오프·intraMax)는 그리기 세그먼트와 동일하게 흐른다. */
  stepSegments: readonly PeakWallSegment[];
  /** 「전체 최대벽(터치 무관)」 하위 선 — `all_*` 패밀리를 carrier 로 옮겨
   *  (toAllWallPeakInputs) 같은 파이프라인으로 지은 세그먼트. rank-1/일 고정
   *  (과거일 wire 가 rank-1 스칼라뿐이라 표시 개수 노브는 받지 않는다). 필터
   *  (MA·컷오프·intraMax)는 체결된 벽과 동일하게 흐른다. `enabled` 기준 계산
   *  불변식도 동일하다. */
  allWallSegments: readonly PeakWallSegment[];
  /** 「보이는 영역」 랭킹(레전드 셀 · 순위 화살표 · 고저 라벨 회피)의 **공용 입력** —
   *  체결된 벽 ∪ 전체 벽 ∪ 미도달 벽을 (그날, 가격) 최대 qty 로 병합한 집합. 세 소비처가
   *  이 하나를 받아야 레전드 1위와 화살표 ① 이 같은 벽을 가리킨다(peakWallVisibleRanking
   *  머리말). 하위 선이 전부 꺼져 있으면 `segments` 와 같은 참조다. */
  rankSegments: readonly PeakWallSegment[];
  /** 「미도달 벽」 하위 선 — unreached 패밀리의 carrier 리맵(toUnreachedWallPeakInputs).
   *  cont 단일 계열이라 intraMax 토글이 무효(양 carrier 동일값)이고, rank-1/일 고정.
   *  극값 전진의 소급 재분류로 **값이 줄어들 수도** 있다(래칫 아님). */
  unreachedSegments: readonly PeakWallSegment[];
  unreachedDrawn: boolean;
  unreachedLabels: boolean;
  unreachedColor: string;
  unreachedLineWidth: number;
  /** 전체 최대벽 선이 실제로 그려지는가(마스터 drawn ∧ 하위 토글). */
  allWallDrawn: boolean;
  /** 전체 최대벽 도킹 라벨이 그려지는가(라벨 pref 는 방향 공용을 따른다). */
  allWallLabels: boolean;
  allWallColor: string;
  allWallLineWidth: number;
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
  dailyMaFilter,
  needStepSegments = false,
}: Args): PeakWallRenderState {
  const isAsk = side === 'ask';
  const enabled = useWindowIndicator((s) => (isAsk ? s.askPeakEnabled : s.bidPeakEnabled));
  const hidden = useWindowIndicator((s) => (isAsk ? s.askPeakHidden : s.bidPeakHidden));
  const color = useWindowIndicator((s) => (isAsk ? s.askPeakColor : s.bidPeakColor));
  const lineWidth = useWindowIndicator((s) => (isAsk ? s.askPeakLineWidth : s.bidPeakLineWidth));
  const allWallEnabled = useWindowIndicator(
    (s) => (isAsk ? s.askPeakAllWallLineEnabled : s.bidPeakAllWallLineEnabled),
  );
  const allWallColor = useWindowIndicator(
    (s) => (isAsk ? s.askPeakAllWallColor : s.bidPeakAllWallColor),
  );
  const allWallLineWidth = useWindowIndicator(
    (s) => (isAsk ? s.askPeakAllWallLineWidth : s.bidPeakAllWallLineWidth),
  );
  const unreachedEnabled = useWindowIndicator(
    (s) => (isAsk ? s.askPeakUnreachedLineEnabled : s.bidPeakUnreachedLineEnabled),
  );
  const unreachedColor = useWindowIndicator(
    (s) => (isAsk ? s.askPeakUnreachedColor : s.bidPeakUnreachedColor),
  );
  const unreachedLineWidth = useWindowIndicator(
    (s) => (isAsk ? s.askPeakUnreachedLineWidth : s.bidPeakUnreachedLineWidth),
  );
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
  ]);

  // 전체 최대벽(터치 무관) 하위 선 — carrier 리맵 후 같은 빌더를 재사용한다.
  // rank-1/일 고정: 과거일 wire 는 all rank-1 스칼라뿐이라(배열은 range 에서 벗겨짐)
  // 표시 개수 노브를 받으면 오늘만 2·3개가 그려져 날마다 개수가 달라 보인다.
  const allWallBuilt = useMemo(() => (
    applicable && enabled && allWallEnabled
      ? buildPeakWallOverlaySegments({
        peaks: toAllWallPeakInputs(peaks),
        segments,
        candles,
        axis,
        todayKst,
        baselineStyle: { color: allWallColor, lineWidth: allWallLineWidth },
        intraMax,
        allPriceRankLimit: 1,
        maFilter,
        dailyMaFilter,
      })
      : EMPTY_SEGMENTS
  ), [
    allWallEnabled,
    allWallColor,
    allWallLineWidth,
    applicable,
    axis,
    candles,
    dailyMaFilter,
    enabled,
    intraMax,
    maFilter,
    peaks,
    segments,
    todayKst,
  ]);

  // 미도달 벽 하위 선 — 전체 최대벽과 같은 리맵·rank-1 규약(위 allWallBuilt 주석).
  const unreachedBuilt = useMemo(() => (
    applicable && enabled && unreachedEnabled
      ? buildPeakWallOverlaySegments({
        peaks: toUnreachedWallPeakInputs(peaks),
        segments,
        candles,
        axis,
        todayKst,
        baselineStyle: { color: unreachedColor, lineWidth: unreachedLineWidth },
        intraMax,
        allPriceRankLimit: 1,
        maFilter,
        dailyMaFilter,
      })
      : EMPTY_SEGMENTS
  ), [
    unreachedEnabled,
    unreachedColor,
    unreachedLineWidth,
    applicable,
    axis,
    candles,
    dailyMaFilter,
    enabled,
    intraMax,
    maFilter,
    peaks,
    segments,
    todayKst,
  ]);

  // 계단 입력 — 표시 개수와 분리한 **stepHistory 모드**(기록 갱신 시퀀스 ∪ top-3,
  // 랭크 슬라이스 없음). 표시 개수 3 과도 다른 결과라 참조 공유 지름길은 없다.
  const stepBuilt = useMemo(() => (
    needStepSegments && applicable && enabled
      ? buildPeakWallOverlaySegments({
        peaks,
        segments,
        candles,
        axis,
        todayKst,
        baselineStyle: { color, lineWidth },
        intraMax,
        allPriceRankLimit: 3,
        stepHistory: true,
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
  ]);

  const drawn = enabled && !hidden;
  const allWallDrawn = drawn && allWallEnabled;
  const unreachedDrawn = drawn && unreachedEnabled;
  // 랭킹 공용 입력 — 하위 선이 전부 비면 mergePeakWallRankSegments 가 built 참조를
  // 그대로 돌려주므로 별도 분기 없이도 참조가 안정된다.
  const rankSegments = useMemo(
    () => mergePeakWallRankSegments(built, allWallBuilt, unreachedBuilt),
    [built, allWallBuilt, unreachedBuilt],
  );
  return useMemo(() => ({
    segments: built,
    drawn,
    labels: drawn && labelEnabled,
    arrows: drawn && rankArrowEnabled,
    color,
    lineWidth,
    stepSegments: stepBuilt ?? built,
    allWallSegments: allWallBuilt,
    rankSegments,
    allWallDrawn,
    allWallLabels: allWallDrawn && labelEnabled,
    allWallColor,
    allWallLineWidth,
    unreachedSegments: unreachedBuilt,
    unreachedDrawn,
    unreachedLabels: unreachedDrawn && labelEnabled,
    unreachedColor,
    unreachedLineWidth,
  }), [
    allWallBuilt,
    allWallColor,
    allWallDrawn,
    allWallLineWidth,
    unreachedBuilt,
    unreachedColor,
    unreachedDrawn,
    unreachedLineWidth,
    built,
    stepBuilt,
    color,
    drawn,
    labelEnabled,
    lineWidth,
    rankArrowEnabled,
  ]);
}
