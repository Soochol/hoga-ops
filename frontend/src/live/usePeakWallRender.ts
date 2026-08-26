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
import type { PeakDailyMaFilters } from './peakWallDailyMaFilter';

/** 계열의 두 표면 토글(수평선 · 발생 시점 화살표)을 **세그먼트에 실어** 내려보낸다.
 *
 * primitive 에 세터를 다는 대신 이 자리를 고른 이유: 이 훅이 내보내는 세그먼트를
 * **세 소비처가 공유**한다 — 선 primitive · 도킹 라벨 · 고저 라벨 회피 rect. 여기서
 * 실어 두면 셋이 자동으로 같은 값을 보고, 특히 회피 간격이 화살표 유무를 따라간다
 * (화살표를 껐는데 라벨만 비켜서면 빈 공간을 피해 떠 있는 **유령 회피**가 된다).
 *
 * 둘 다 켜져 있으면 **원본 배열을 그대로 돌려준다** — 기본 상태에서 참조가 바뀌지
 * 않아야 하류 memo 와 primitive 재갱신이 헛돌지 않는다. */
function withPeakWallSurfaces(
  segments: readonly PeakWallSegment[],
  horizontalLine: boolean,
  timeMarker: boolean,
): readonly PeakWallSegment[] {
  if (horizontalLine && timeMarker) return segments;
  return segments.map((segment) => ({ ...segment, horizontalLine, timeMarker }));
}

export type PeakWallRenderState = {
  /** 필터를 모두 통과한 세그먼트. **`enabled` 기준으로만** 계산한다(위 불변식 참조). */
  segments: readonly PeakWallSegment[];
  /** 선이 실제로 그려지는가 — 「지금 그려지는가」의 **단일 정의**. */
  drawn: boolean;
  /** 도킹 라벨이 그려지는가. */
  labels: boolean;
  /** 순위 화살표가 하나라도 그려지는가 — 계열별 참여는 `arrowRankSegments` 가 담는다. */
  arrows: boolean;
  /** 레전드 순위 셀을 채우는가. ⚠ **행이 아니라 셀만** 가른다 — 행이 사라지면
   *  다시 켤 표면(눈 아이콘)이 없어진다. provider 는 늘 등록돼 있고 이 값이
   *  false 면 빈 셀 목록을 낸다. `hidden` 과 무관하다(눈은 선만 숨긴다). */
  legendCells: boolean;
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
  /** 레전드 순위 셀의 랭킹 입력 — **레전드 참여가 켜진 계열만** 병합한 집합.
   *  `hidden` 과 무관하다(눈은 선만 숨긴다). */
  legendRankSegments: readonly PeakWallSegment[];
  /** 순위 화살표 · **고저 극값 라벨 회피**의 랭킹 입력 — 화살표 참여가 켜진 계열만.
   *
   *  ⚠ 회피 rect 는 반드시 이쪽을 쓴다. 「그려지는 화살표만 피한다」가 그 계산의 뜻이라
   *  레전드 집합을 넘기면 화면에 없는 화살표를 피하고 있는 벽이 생긴다.
   *
   *  ⚠ 레전드와 이 집합이 다를 수 있다는 것이 계열별 분리의 **의도된 결과**다. 두 표면에
   *  서로 다른 계열을 켜면 레전드 ②와 화살표 ②가 다른 벽을 가리킨다 — 종전엔 집합이
   *  하나라 원리적으로 불가능했던 상태다(peakWallVisibleRanking 머리말의 "같은 함수를
   *  써야 한다" 는 **랭커**를 말하는 것이고, 그 규칙은 여기서도 지켜진다). */
  arrowRankSegments: readonly PeakWallSegment[];
  /** 「미도달 벽」 하위 선 — unreached 패밀리의 carrier 리맵(toUnreachedWallPeakInputs).
   *  cont 단일 계열이라 intraMax 토글이 무효(양 carrier 동일값)이고, rank-1/일 고정.
   *  극값 전진의 소급 재분류로 **값이 줄어들 수도** 있다(래칫 아님). */
  unreachedSegments: readonly PeakWallSegment[];
  /** 「전체 최대벽」의 강도 pane 계단 입력. 이 계열은 **단조**라(벽이 빠져나가지
   *  않는다) 체결된 벽과 같은 running-max 빌더를 쓴다. pane 이 꺼져 있거나 이
   *  계열 선이 꺼져 있으면 빈 배열. */
  allWallStepSegments: readonly PeakWallSegment[];
  /** 「미도달 벽」의 강도 pane 계단 입력. ⚠ 이 계열은 **단조가 아니다** — 극값
   *  전진이 구성원을 빼앗으므로 소비처는 `buildUnreachedStepPoints`(비단조)를
   *  써야 한다. running-max 빌더를 태우면 깨진 벽이 영원히 남는다. */
  unreachedStepSegments: readonly PeakWallSegment[];
  unreachedDrawn: boolean;
  unreachedLabels: boolean;
  unreachedColor: string;
  unreachedLineWidth: number;
  /** 전체 최대벽 선이 실제로 그려지는가(마스터 drawn ∧ 하위 토글). */
  allWallDrawn: boolean;
  /** 전체 최대벽 도킹 라벨이 그려지는가(이 계열 전용 라벨 pref). */
  allWallLabels: boolean;
  allWallColor: string;
  allWallLineWidth: number;
  // ── 계열별 표면 둘 (2026-08-26) ────────────────────────────────────────
  // 수평선과 발생 시점 화살표는 **서로 독립**이다. 계열 `*Drawn` 이 그 계열이 화면에
  // 있는지를 말하고, 이 여섯은 있는 계열을 **어떻게 그릴지**를 말한다. 세그먼트에
  // 실려 primitive 까지 내려가며(도킹 라벨의 회피 간격도 화살표 쪽을 따라간다).
  tradedHorizontalLine: boolean;
  tradedTimeMarker: boolean;
  allWallHorizontalLine: boolean;
  allWallTimeMarker: boolean;
  unreachedHorizontalLine: boolean;
  unreachedTimeMarker: boolean;
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
  /** 계열별 일봉 MA 필터 — 데이터 fetch 가 걸린 훅이라 `LiveChartRoot` 가 한 번 계산해
   *  넘긴다(계열이 셋이어도 fetch 는 하나 — `usePeakDailyMaFilters` 머리말). */
  dailyMaFilters: PeakDailyMaFilters;
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
  dailyMaFilters,
  needStepSegments = false,
}: Args): PeakWallRenderState {
  const isAsk = side === 'ask';
  const enabled = useWindowIndicator((s) => (isAsk ? s.askPeakEnabled : s.bidPeakEnabled));
  const hidden = useWindowIndicator((s) => (isAsk ? s.askPeakHidden : s.bidPeakHidden));
  const color = useWindowIndicator((s) => (isAsk ? s.askPeakColor : s.bidPeakColor));
  const lineWidth = useWindowIndicator((s) => (isAsk ? s.askPeakLineWidth : s.bidPeakLineWidth));
  // 체결된 벽도 이제 **세 계열 중 하나**다 — 자기 토글로 켜고 끈다(기본 true).
  // 마스터(`enabled`)와 다른 층위: 마스터는 계산 자체, 이건 이 계열의 선.
  const tradedEnabled = useWindowIndicator(
    (s) => (isAsk ? s.askPeakTradedLineEnabled : s.bidPeakTradedLineEnabled),
  );
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
  // 표면 셋(라벨 · 화살표 · 레전드 셀)은 이제 **계열마다** 따로다. 종전엔 방향당 하나라
  // "체결된 벽만 라벨" 같은 조합이 원리적으로 불가능했다.
  // 수평선과 발생 시점 화살표는 **독립 토글**이다(2026-08-26). 종전엔 계열 선 토글
  // (`*LineEnabled`) 하나가 둘을 함께 켰다. 네 조합이 전부 유효하다 — 화살표는 벽 가격 y 에
  // 앵커하므로 선이 없어도 위치를 말하고, 둘 다 끄면 라벨만 남는 표시가 된다.
  // 계열 선 토글은 그대로 **계열의 존재**를 뜻한다(꺼지면 세그먼트가 아예 안 온다).
  const tradedHorizontalLineEnabled = useActivePrefs(
    (s) => (isAsk ? s.askPeakTradedHorizontalLineEnabled : s.bidPeakTradedHorizontalLineEnabled),
  );
  const tradedTimeMarkerEnabled = useActivePrefs(
    (s) => (isAsk ? s.askPeakTradedTimeMarkerEnabled : s.bidPeakTradedTimeMarkerEnabled),
  );
  const allWallHorizontalLineEnabled = useActivePrefs(
    (s) => (isAsk ? s.askPeakAllWallHorizontalLineEnabled : s.bidPeakAllWallHorizontalLineEnabled),
  );
  const allWallTimeMarkerEnabled = useActivePrefs(
    (s) => (isAsk ? s.askPeakAllWallTimeMarkerEnabled : s.bidPeakAllWallTimeMarkerEnabled),
  );
  const unreachedHorizontalLineEnabled = useActivePrefs(
    (s) => (isAsk ? s.askPeakUnreachedHorizontalLineEnabled : s.bidPeakUnreachedHorizontalLineEnabled),
  );
  const unreachedTimeMarkerEnabled = useActivePrefs(
    (s) => (isAsk ? s.askPeakUnreachedTimeMarkerEnabled : s.bidPeakUnreachedTimeMarkerEnabled),
  );
  const tradedLabelEnabled = useActivePrefs(
    (s) => (isAsk ? s.askPeakTradedLabelEnabled : s.bidPeakTradedLabelEnabled),
  );
  const unreachedLabelEnabled = useActivePrefs(
    (s) => (isAsk ? s.askPeakUnreachedLabelEnabled : s.bidPeakUnreachedLabelEnabled),
  );
  const allWallLabelEnabled = useActivePrefs(
    (s) => (isAsk ? s.askPeakAllWallLabelEnabled : s.bidPeakAllWallLabelEnabled),
  );
  // 계열별 「표시 개수」 — 종전엔 전체·미도달이 rank-1 고정이었다(과거일 wire 가
  // rank-1 스칼라뿐이었기 때문). 백엔드가 top-3 를 싣게 되면서 풀렸다.
  const allWallRankLimit = useActivePrefs(
    (s) => (isAsk ? s.askPeakAllWallRankLimit : s.bidPeakAllWallRankLimit),
  );
  const unreachedRankLimit = useActivePrefs(
    (s) => (isAsk ? s.askPeakUnreachedRankLimit : s.bidPeakUnreachedRankLimit),
  );
  const tradedLegendCellEnabled = useActivePrefs(
    (s) => (isAsk ? s.askPeakTradedLegendCellEnabled : s.bidPeakTradedLegendCellEnabled),
  );
  const unreachedLegendCellEnabled = useActivePrefs(
    (s) => (isAsk ? s.askPeakUnreachedLegendCellEnabled : s.bidPeakUnreachedLegendCellEnabled),
  );
  const allWallLegendCellEnabled = useActivePrefs(
    (s) => (isAsk ? s.askPeakAllWallLegendCellEnabled : s.bidPeakAllWallLegendCellEnabled),
  );
  const tradedRankArrowEnabled = useActivePrefs(
    (s) => (isAsk ? s.askPeakTradedRankArrowEnabled : s.bidPeakTradedRankArrowEnabled),
  );
  const unreachedRankArrowEnabled = useActivePrefs(
    (s) => (isAsk ? s.askPeakUnreachedRankArrowEnabled : s.bidPeakUnreachedRankArrowEnabled),
  );
  const allWallRankArrowEnabled = useActivePrefs(
    (s) => (isAsk ? s.askPeakAllWallRankArrowEnabled : s.bidPeakAllWallRankArrowEnabled),
  );
  // 분봉 MA 필터도 계열별 — 훅을 셋 부른다(각자 자기 pref 쌍을 읽는다). 세션 필터 + SMA
  // 결과는 캔들 배열 참조에 매달린 `byPeriod` 캐시라, 기간이 갈려도 훑기는 기간당 한 번이다.
  const tradedMaFilter = usePeakMaFilter(side, 'Traded');
  const unreachedMaFilter = usePeakMaFilter(side, 'Unreached');
  const allWallMaFilter = usePeakMaFilter(side, 'AllWall');
  const tradedDailyMaFilter = dailyMaFilters.Traded;
  const unreachedDailyMaFilter = dailyMaFilters.Unreached;
  const allWallDailyMaFilter = dailyMaFilters.AllWall;

  const built = useMemo(() => (
    applicable && enabled && tradedEnabled
      ? buildPeakWallOverlaySegments({
        peaks,
        segments,
        candles,
        axis,
        todayKst,
        baselineStyle: { color, lineWidth },
        intraMax,
        allPriceRankLimit: toPeakRankLimit(allPriceRankLimit),
        maFilter: tradedMaFilter,
        dailyMaFilter: tradedDailyMaFilter,
      })
      : EMPTY_SEGMENTS
  ), [
    tradedEnabled,
    allPriceRankLimit,
    applicable,
    axis,
    candles,
    color,
    tradedDailyMaFilter,
    enabled,
    intraMax,
    lineWidth,
    tradedMaFilter,
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
        allPriceRankLimit: toPeakRankLimit(allWallRankLimit),
        maFilter: allWallMaFilter,
        dailyMaFilter: allWallDailyMaFilter,
      })
      : EMPTY_SEGMENTS
  ), [
    allWallEnabled,
    allWallColor,
    allWallLineWidth,
    allWallRankLimit,
    applicable,
    axis,
    candles,
    allWallDailyMaFilter,
    enabled,
    intraMax,
    allWallMaFilter,
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
        allPriceRankLimit: toPeakRankLimit(unreachedRankLimit),
        maFilter: unreachedMaFilter,
        dailyMaFilter: unreachedDailyMaFilter,
      })
      : EMPTY_SEGMENTS
  ), [
    unreachedEnabled,
    unreachedColor,
    unreachedLineWidth,
    unreachedRankLimit,
    applicable,
    axis,
    candles,
    unreachedDailyMaFilter,
    enabled,
    intraMax,
    unreachedMaFilter,
    peaks,
    segments,
    todayKst,
  ]);

  // 하위 계열의 계단 입력 — 그리기 선과 같은 carrier 리맵을 쓰되 랭크로 자르지
  // 않는다(stepHistory). 두 계열 다 `traded_record_*` 가 없어 후보는 그 계열의
  // top-3(과거일은 rank-1 스칼라)이다 — 빌더 docstring 이 그 근사를 적는다.
  const allWallStepBuilt = useMemo(() => (
    needStepSegments && applicable && enabled && allWallEnabled
      ? buildPeakWallOverlaySegments({
        peaks: toAllWallPeakInputs(peaks),
        segments,
        candles,
        axis,
        todayKst,
        baselineStyle: { color: allWallColor, lineWidth: allWallLineWidth },
        intraMax,
        allPriceRankLimit: 3,
        stepHistory: true,
        maFilter: allWallMaFilter,
        dailyMaFilter: allWallDailyMaFilter,
      })
      : EMPTY_SEGMENTS
  ), [
    needStepSegments, allWallEnabled, allWallColor, allWallLineWidth, applicable,
    axis, candles, allWallDailyMaFilter, enabled, intraMax, allWallMaFilter, peaks, segments, todayKst,
  ]);

  const unreachedStepBuilt = useMemo(() => (
    needStepSegments && applicable && enabled && unreachedEnabled
      ? buildPeakWallOverlaySegments({
        peaks: toUnreachedWallPeakInputs(peaks),
        segments,
        candles,
        axis,
        todayKst,
        baselineStyle: { color: unreachedColor, lineWidth: unreachedLineWidth },
        intraMax,
        allPriceRankLimit: 3,
        stepHistory: true,
        maFilter: unreachedMaFilter,
        dailyMaFilter: unreachedDailyMaFilter,
      })
      : EMPTY_SEGMENTS
  ), [
    needStepSegments, unreachedEnabled, unreachedColor, unreachedLineWidth, applicable,
    axis, candles, unreachedDailyMaFilter, enabled, intraMax, unreachedMaFilter, peaks, segments, todayKst,
  ]);

  // 계단 입력 — 표시 개수와 분리한 **stepHistory 모드**(기록 갱신 시퀀스 ∪ top-3,
  // 랭크 슬라이스 없음). 표시 개수 3 과도 다른 결과라 참조 공유 지름길은 없다.
  const stepBuilt = useMemo(() => (
    needStepSegments && applicable && enabled && tradedEnabled
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
        maFilter: tradedMaFilter,
        dailyMaFilter: tradedDailyMaFilter,
      })
      : null
  ), [
    needStepSegments,
    tradedEnabled,
    allPriceRankLimit,
    applicable,
    axis,
    candles,
    color,
    tradedDailyMaFilter,
    enabled,
    intraMax,
    lineWidth,
    tradedMaFilter,
    peaks,
    segments,
    todayKst,
  ]);

  const drawn = enabled && !hidden;
  const allWallDrawn = drawn && allWallEnabled;
  const unreachedDrawn = drawn && unreachedEnabled;
  // 랭킹 입력 — **표면마다 자기 후보 집합**을 병합한다. 참여가 꺼진 계열은 빈 배열로
  // 들어가므로 랭킹에서 빠지고, 켜진 계열이 하나도 없으면 결과도 빈 집합이다.
  // 계열 선 자체가 꺼져 있으면(`*Enabled`) 그 계열의 `built` 가 이미 비어 있어 여기서
  // 다시 볼 필요가 없다 — 그 게이트는 빌더가 갖는다.
  const legendRankSegments = useMemo(
    () => mergePeakWallRankSegments(
      tradedLegendCellEnabled ? built : EMPTY_SEGMENTS,
      allWallLegendCellEnabled ? allWallBuilt : EMPTY_SEGMENTS,
      unreachedLegendCellEnabled ? unreachedBuilt : EMPTY_SEGMENTS,
    ),
    [
      built, allWallBuilt, unreachedBuilt,
      tradedLegendCellEnabled, allWallLegendCellEnabled, unreachedLegendCellEnabled,
    ],
  );
  const arrowRankSegments = useMemo(
    () => mergePeakWallRankSegments(
      tradedRankArrowEnabled ? built : EMPTY_SEGMENTS,
      allWallRankArrowEnabled ? allWallBuilt : EMPTY_SEGMENTS,
      unreachedRankArrowEnabled ? unreachedBuilt : EMPTY_SEGMENTS,
    ),
    [
      built, allWallBuilt, unreachedBuilt,
      tradedRankArrowEnabled, allWallRankArrowEnabled, unreachedRankArrowEnabled,
    ],
  );
  // 표면 플래그를 세그먼트에 실어 내보낸다(위 `withPeakWallSurfaces` 주석 참조).
  const surfacedSegments = useMemo(
    () => withPeakWallSurfaces(built, tradedHorizontalLineEnabled, tradedTimeMarkerEnabled),
    [built, tradedHorizontalLineEnabled, tradedTimeMarkerEnabled],
  );
  const surfacedAllWallSegments = useMemo(
    () => withPeakWallSurfaces(allWallBuilt, allWallHorizontalLineEnabled, allWallTimeMarkerEnabled),
    [allWallBuilt, allWallHorizontalLineEnabled, allWallTimeMarkerEnabled],
  );
  const surfacedUnreachedSegments = useMemo(
    () => withPeakWallSurfaces(unreachedBuilt, unreachedHorizontalLineEnabled, unreachedTimeMarkerEnabled),
    [unreachedBuilt, unreachedHorizontalLineEnabled, unreachedTimeMarkerEnabled],
  );
  return useMemo(() => ({
    segments: surfacedSegments,
    drawn,
    labels: drawn && tradedLabelEnabled,
    // 「하나라도 그리는가」 — 어느 계열이 그려지는지는 `arrowRankSegments` 가 담는다.
    arrows: drawn
      && (tradedRankArrowEnabled || allWallRankArrowEnabled || unreachedRankArrowEnabled),
    legendCells: tradedLegendCellEnabled
      || allWallLegendCellEnabled
      || unreachedLegendCellEnabled,
    color,
    lineWidth,
    stepSegments: stepBuilt ?? built,
    allWallSegments: surfacedAllWallSegments,
    legendRankSegments,
    arrowRankSegments,
    allWallDrawn,
    allWallLabels: allWallDrawn && allWallLabelEnabled,
    allWallColor,
    allWallLineWidth,
    unreachedSegments: surfacedUnreachedSegments,
    allWallStepSegments: allWallStepBuilt,
    unreachedStepSegments: unreachedStepBuilt,
    unreachedDrawn,
    unreachedLabels: unreachedDrawn && unreachedLabelEnabled,
    unreachedColor,
    unreachedLineWidth,
    tradedHorizontalLine: tradedHorizontalLineEnabled,
    tradedTimeMarker: tradedTimeMarkerEnabled,
    allWallHorizontalLine: allWallHorizontalLineEnabled,
    allWallTimeMarker: allWallTimeMarkerEnabled,
    unreachedHorizontalLine: unreachedHorizontalLineEnabled,
    unreachedTimeMarker: unreachedTimeMarkerEnabled,
  }), [
    surfacedSegments,
    surfacedAllWallSegments,
    surfacedUnreachedSegments,
    tradedHorizontalLineEnabled,
    tradedTimeMarkerEnabled,
    allWallHorizontalLineEnabled,
    allWallTimeMarkerEnabled,
    unreachedHorizontalLineEnabled,
    unreachedTimeMarkerEnabled,
    allWallStepBuilt,
    unreachedStepBuilt,
    allWallColor,
    allWallDrawn,
    allWallLineWidth,
    unreachedColor,
    unreachedDrawn,
    unreachedLineWidth,
    built,
    stepBuilt,
    color,
    drawn,
    tradedLabelEnabled,
    unreachedLabelEnabled,
    allWallLabelEnabled,
    tradedLegendCellEnabled,
    unreachedLegendCellEnabled,
    allWallLegendCellEnabled,
    tradedRankArrowEnabled,
    unreachedRankArrowEnabled,
    allWallRankArrowEnabled,
    lineWidth,
    legendRankSegments,
    arrowRankSegments,
  ]);
}
