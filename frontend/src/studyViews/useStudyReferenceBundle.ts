import { useStudyChartIndicators } from './useStudyChartIndicators';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import { useLiveVenueStore } from '../state/liveVenue';
import { useEffectiveVenue } from '../live/useEffectiveVenue';
import { useOrderflowSourcePref } from '../state/sourcePreference';
import type { LiveDataWarning } from '../live/liveDataWarnings';
import type { LiveEffectiveSession } from '../api/livePastCandles';
import type { StudyViewReference } from '../api/studyViews';
import type { RangeBundle } from '../api/types';
import { buildStudyReferenceBundleModel } from './studyReferenceBundleModel';
import type { StudyDailyContextWindow } from './studyDailyContext';
import { studyReferenceQueryOptions } from './studyReferenceQueries';

function mergeStudyRangeBundles(
  hoga: RangeBundle | null,
  sidecars: RangeBundle | null,
): RangeBundle | null {
  if (!hoga) return sidecars;
  if (!sidecars) return hoga;
  return {
    ...hoga,
    ask_peaks: sidecars.ask_peaks ?? [],
    bid_peaks: sidecars.bid_peaks ?? [],
    broker_late_entries: sidecars.broker_late_entries ?? [],
    trade_volume_pocs: sidecars.trade_volume_pocs ?? [],
    depth_heatmap: sidecars.depth_heatmap ?? [],
    volume_distributions: sidecars.volume_distributions ?? [],
  };
}

// 복기뷰 캔들은 디스크 캡처(hogaplay + 스크리너 일봉)만 쓴다 — KIS rate-limit/지연 경고
// 채널이 없으므로 항상 빈 배열. RangeBundle의 data_warnings는 invariant 위반 타입이라
// KIS 지연 칩(LiveDataWarning)으로 표기하면 오해를 준다(디스크는 지연 개념이 없음).
const EMPTY_WARNINGS: LiveDataWarning[] = [];

export function useStudyReferenceBundle(
  save: StudyViewReference | null,
  /** 캘린더 봉 맥락 창(`studyDailyContext`). null = 저장 구간만(분봉 경로). */
  dailyContext: StudyDailyContextWindow = null,
) {
  // 복기뷰가 **공유 venue 스토어를 읽는다**(ADR-0140 §7). 여기 있던 `STUDY_VENUE =
  // 'KRX'` 고정은 "복기는 hogaplay 정규장 캡처만 쓴다"는 사실에서 나온 것이었는데,
  // PR-D 가 디스크에 `kiwoom_live/{venue}/` 를 만들면서 고를 대상이 생겼다.
  //
  // ⚠ hogaplay 는 여전히 KRX 전용이라 **NXT·통합이 비는 날이 있다**. 그건 장애가
  // 아니라 그 소스의 커버 범위이고, 어느 날에 무엇이 있는지는 보관함의 시장 배지가
  // 말한다(같은 `expected_venues` 판정을 공유한다).
  //
  // 선택값이 아니라 **이 종목에 대한 해석값**을 쓴다. `studyReferenceQueries` 는 순수
  // 함수라 `rangeBundleQueryOptions` 를 직접 만들고, 그래서 `useRange` 안의 해석
  // (#1214)을 타지 않는다 — 해석은 여기서 해 넣어야 한다. 안 하면 NXT 미상장 종목에
  // 통합을 고른 복기 뷰가 **빈 200** 을 받는다(`kiwoom_live/UN/` 이 애초에 안 생긴다).
  const selectedVenue = useLiveVenueStore((s) => s.venue);
  const venue = useEffectiveVenue(save?.code, selectedVenue);
  const sourcePref = useOrderflowSourcePref();
  // 지표는 차트 창이 소유한다(#904) — 전역을 읽으면 차트가 그릴 지표와 여기서
  // 받아오는 데이터가 어긋난다.
  const {
    brokerLateEntryEnabled,
    brokerLateEntryStartHHMM,
    tradeVolumePocEnabled,
    depthHeatmapEnabled,
    volumeDistributionEnabled,
    volumeDistributionRangeCount,
  } = useStudyChartIndicators();
  const queryOptions = useMemo(
    () => studyReferenceQueryOptions(save, {
      sourcePref,
      brokerLateEntryEnabled,
      brokerLateEntryStartHHMM,
      tradeVolumePocEnabled,
      depthHeatmapEnabled,
      volumeDistributionEnabled,
      volumeDistributionRangeCount,
      venue,
    }, dailyContext),
    [
      save,
      dailyContext,
      venue,
      brokerLateEntryEnabled,
      brokerLateEntryStartHHMM,
      sourcePref,
      tradeVolumePocEnabled,
      depthHeatmapEnabled,
      volumeDistributionEnabled,
      volumeDistributionRangeCount,
    ],
  );

  const pastHoga = useQuery(queryOptions.rangeHoga);
  const pastSidecars = useQuery(queryOptions.rangeSidecars);
  const rangeCandles = useQuery(queryOptions.rangeCandles);
  const screenerDaily = useQuery(queryOptions.screenerDaily);

  const pastBundle = useMemo(
    () => mergeStudyRangeBundles(pastHoga.data ?? null, pastSidecars.data ?? null),
    [pastHoga.data, pastSidecars.data],
  );
  const rangeCandleData = rangeCandles.data?.candles ?? [];
  const screenerDailyData = screenerDaily.data?.candles ?? [];

  // 세션 경계: 캡처 meta의 정규장 경계(RangeSegment)를 effective session으로 주입.
  // 세그먼트가 없는 날짜는 모델의 venue 폴백(effectiveSessionBoundsByDate 미스 경로)이 처리.
  const sessions = useMemo<LiveEffectiveSession[]>(
    () => (rangeCandles.data?.segments ?? []).map((s) => ({
      date: s.date,
      venue,
      open_ms: s.session_open_ms,
      close_ms: s.session_close_ms,
    })),
    [rangeCandles.data?.segments, venue],
  );

  const model = useMemo(
    () => buildStudyReferenceBundleModel({
      save,
      venue,
      pastBundle,
      rangeCandles: rangeCandleData,
      screenerDailyCandles: screenerDailyData,
      sessions,
      dailyContext,
    }),
    [dailyContext, pastBundle, rangeCandleData, save, screenerDailyData, sessions, venue],
  );

  return {
    bundle: model.bundle,
    chartBundle: model.chartBundle,
    // 사이드카(최대벽·POC·거래량분포·프로그램매매)도 첫 커밋에 캔들과 함께 등장하도록
    // 풀스크린 게이트에 포함(개선안 1-C). 비활성 쿼리는 react-query v5에서 isLoading=false라
    // 분봉/캘린더 저장을 단일식으로 커버한다(분봉=pastHoga+rangeCandles+sidecars,
    // D/W/M=rangeCandles+screenerDaily). data==null 조건: 에러/캐시 히트로 settle되면 즉시 열림.
    isLoading:
      pastHoga.isLoading ||
      rangeCandles.isLoading ||
      screenerDaily.isLoading ||
      (pastSidecars.isLoading && pastSidecars.data == null),
    error: pastHoga.error ?? rangeCandles.error ?? screenerDaily.error ?? pastSidecars.error ?? null,
    pastDataWarnings: EMPTY_WARNINGS,
    venue,
  };
}
