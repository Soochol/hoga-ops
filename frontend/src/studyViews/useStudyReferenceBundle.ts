import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import type { LiveVenueOption } from '../state/liveVenue';
import { useLivePageStore } from '../state/livePage';
import { useSourcePreferenceStore } from '../state/sourcePreference';
import type { LiveDataWarning } from '../live/liveDataWarnings';
import type { LiveEffectiveSession } from '../api/livePastCandles';
import type { StudyViewReference } from '../api/studyViews';
import type { RangeBundle } from '../api/types';
import { buildStudyReferenceBundleModel } from './studyReferenceBundleModel';
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

// 안정 참조 — 복구일 없을 때 매 렌더 새 배열 생성으로 배지 memo가 깨지지 않도록.
const EMPTY_REPAIRED_DATES: string[] = [];

// 복기뷰는 hogaplay 정규장 캡처(KRX)만 쓴다 — venue는 KRX 고정. 공유
// live.venue.v1 스토어를 읽지 않아, /live에서 NXT/통합으로 바꿔도 study는 불변.
// venue는 캔들 소스엔 무영향이고 세션 경계 폴백 렌더링에만 관여한다.
const STUDY_VENUE: LiveVenueOption = 'KRX';

export function useStudyReferenceBundle(save: StudyViewReference | null) {
  const venue = STUDY_VENUE;
  const sourcePref = useSourcePreferenceStore((s) => s.sourcePreference);
  const brokerLateEntryEnabled = useLivePageStore((s) => s.brokerLateEntryEnabled);
  const brokerLateEntryStartHHMM = useLivePageStore((s) => s.brokerLateEntryStartHHMM);
  const tradeVolumePocEnabled = useLivePageStore((s) => s.tradeVolumePocEnabled);
  const depthHeatmapEnabled = useLivePageStore((s) => s.depthHeatmapEnabled);
  const volumeDistributionEnabled = useLivePageStore((s) => s.volumeDistributionEnabled);
  const volumeDistributionRangeCount = useLivePageStore((s) => s.volumeDistributionRangeCount);
  const queryOptions = useMemo(
    () => studyReferenceQueryOptions(save, {
      sourcePref,
      brokerLateEntryEnabled,
      brokerLateEntryStartHHMM,
      tradeVolumePocEnabled,
      depthHeatmapEnabled,
      volumeDistributionEnabled,
      volumeDistributionRangeCount,
    }),
    [
      save,
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
    }),
    [pastBundle, rangeCandleData, save, screenerDailyData, sessions, venue],
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
    // hogaplay 공백을 KIS 분봉으로 복구한 거래일 — 캔들 응답에서만 흐른다(디스크 캡처
    // 정본). 배지로 "이 날 캔들은 KIS 보충 · 호가 지표 없음"을 알린다.
    repairedCandleDates: rangeCandles.data?.repaired_candle_dates ?? EMPTY_REPAIRED_DATES,
    venue,
  };
}
