import type { StudyViewReference } from '../api/studyViews';
import { rangeBundleQueryOptions } from '../api/range';
import { screenerDailyCandlesQueryOptions } from '../api/screenerDailyCandles';
import type { IndicatorSettings } from '../state/indicatorSettingsV2';
import type { LiveVenueOption } from '../state/liveVenue';
import type { SourcePreference } from '../state/sourcePreference';
import { studyReferenceQueryInputs } from './studyReferenceBundleModel';
import type { StudyDailyContextWindow } from './studyDailyContext';

export type StudyReferenceQuerySettings = {
  /** undefined = 설정 로딩 중 → `rangeBundleQueryOptions` 가 `enabled=false` 로 막는다. */
  sourcePref: SourcePreference | undefined;
  /** 최대벽(매도·매수). 끄면 계산·전송 둘 다 준다 — 전에는 플래그를 아예 안 넘겨
   *  백엔드 기본값 `True` 로 **항상** 계산됐다. */
  askPeakEnabled: boolean;
  bidPeakEnabled: boolean;
  /** 복기 거래소. `/study` 는 항상 KRX 다(`studyVenuePolicy`, ADR-0144) — 호출부가
   *  `STUDY_VENUE` 를 넘긴다. 순수 함수 쪽에서 상수를 다시 박지 않는 이유는 정책을
   *  되돌릴 때 **고칠 곳이 하나**여야 하기 때문이다. */
  venue: LiveVenueOption;
  brokerLateEntryEnabled: boolean;
  brokerLateEntryStartHHMM: number;
  volumeDistributionEnabled: boolean;
  tradeVolumePocEnabled: boolean;
  depthHeatmapEnabled: boolean;
  volumeDistributionRangeCount: number;
};

/**
 * 지표 설정 한 벌을 쿼리 설정으로 편다.
 *
 * 이 매핑을 소비자마다 손으로 반복하면 **한쪽만 다른 지표를 읽어도 타입이 안 잡는다**
 * — 실제로 그랬다. 비활성 탭 워밍이 `useStudyChartIndicators()`(= **포커스 창**의 봉
 * 기준)를 읽는 동안 쿼리의 `bucket_ms` 는 **탭의 봉**이라, 포커스가 D 이고 워밍
 * 대상이 분봉이면 "분봉 버킷 + D 프로필 지표" 라는 잡종 키가 나갔다. 워밍이 헛돌고
 * 활성 전환에서 같은 구간을 플래그만 바꿔 한 번 더 받는다(실측: 같은 5개월 구간에
 * `depth_heatmap_enabled` 만 다른 sidecar 두 벌, 각 1~1.9MB).
 *
 * 지표 프로필은 `'minute' | 'D' | 'W' | 'M'` 네 개뿐이라(`profileKeyForTimeframe`)
 * 분봉끼리는 어차피 같은 값이다 — 즉 이 잡종은 **캘린더 봉이 섞일 때만** 생기고,
 * 그래서 오래 안 보였다.
 *
 * venue 는 인자로 받는다 — `/study` 가 KRX 고정이라도(ADR-0144) 그 상수를 여기
 * 다시 박으면 정책을 되돌릴 때 고칠 곳이 둘이 된다.
 */
export function studyReferenceQuerySettings(
  indicators: IndicatorSettings,
  sourcePref: SourcePreference | undefined,
  venue: LiveVenueOption,
): StudyReferenceQuerySettings {
  return {
    sourcePref,
    venue,
    askPeakEnabled: indicators.askPeakEnabled,
    bidPeakEnabled: indicators.bidPeakEnabled,
    brokerLateEntryEnabled: indicators.brokerLateEntryEnabled,
    brokerLateEntryStartHHMM: indicators.brokerLateEntryStartHHMM,
    tradeVolumePocEnabled: indicators.tradeVolumePocEnabled,
    depthHeatmapEnabled: indicators.depthHeatmapEnabled,
    volumeDistributionEnabled: indicators.volumeDistributionEnabled,
    volumeDistributionRangeCount: indicators.volumeDistributionRangeCount,
  };
}

export function studyReferenceHogaRangeOptions(
  save: StudyViewReference | null,
  settings: StudyReferenceQuerySettings,
) {
  const inputs = studyReferenceQueryInputs(save);
  return rangeBundleQueryOptions({
    code: inputs.range.code,
    from: inputs.range.from,
    to: inputs.range.to,
    timeframe: inputs.range.timeframe,
    todayKst: null,
    sourcePref: settings.sourcePref,
    venue: settings.venue,
    options: {
      mode: 'hoga',
    },
  });
}

export function studyReferenceSidecarRangeOptions(
  save: StudyViewReference | null,
  settings: StudyReferenceQuerySettings,
) {
  const inputs = studyReferenceQueryInputs(save);
  return rangeBundleQueryOptions({
    code: inputs.range.code,
    from: inputs.range.from,
    to: inputs.range.to,
    timeframe: inputs.range.timeframe,
    todayKst: null,
    sourcePref: settings.sourcePref,
    venue: settings.venue,
    options: {
      mode: 'sidecar',
      // 지표 플래그는 **전부 명시한다.** 빠뜨리면 백엔드 기본값(`Query(True)`)이 먹어
      // 꺼 둔 지표까지 계산·전송된다 — 침묵하는 낭비라 타입도 안 잡는다.
      askPeaksEnabled: settings.askPeakEnabled,
      bidPeaksEnabled: settings.bidPeakEnabled,
      // ⚠ `/study` 는 **단별 잔량 증감을 쓰지 않는다.** `mergeStudyRangeBundles` 의 병합
      // 목록에 `depth_delta` 가 없어 sidecar 가 실어 온 값이 화면에 닿지 않는다. 그런데
      // 플래그를 안 넘겨 기본값 `True` 로 **계산되고 전송돼 왔다** — 하루치 10분봉 실측으로
      // 응답 55,272B → 26,258B(-53%) · 0.409s → 0.246s(-40%). 1분봉은 그 지표 캐시가
      // 파일당 836KB(4종 중 최대)라 차이가 더 크다.
      //
      // 되살리려면(= `/study` 에서도 이 지표를 그리려면) 여기만 켜면 안 된다 — 병합
      // 목록과 지표 드로어 노출(`StudyIndicatorDrawer` 의 `hiddenCategories`)을 같이 되돌려야
      // "켰는데 안 보임" 이 안 생긴다.
      depthDeltaEnabled: false,
      brokerLateEntriesEnabled: settings.brokerLateEntryEnabled,
      brokerLateEntryStartHHMM: settings.brokerLateEntryEnabled ? settings.brokerLateEntryStartHHMM : null,
      volumeDistributionBins: settings.volumeDistributionEnabled ? settings.volumeDistributionRangeCount : null,
      // ⚠ `bins` 를 null 로 두는 것만으로는 **안 꺼진다.** 백엔드는 게이트를
      // `trade_volume_poc_enabled`(기본 `True`)로 보고, bins 는
      // `trade_volume_poc_bins or DEFAULT_TRADE_VOLUME_POC_BINS` 로 폴백한다 —
      // 즉 지표를 꺼도 기본 bins 로 계산됐다. `volume_distribution` 은 게이트가
      // `bins is not None` 이라 같은 실수가 없다(그래서 이 비대칭이 안 보였다).
      tradeVolumePocEnabled: settings.tradeVolumePocEnabled,
      tradeVolumePocBins: settings.tradeVolumePocEnabled ? settings.volumeDistributionRangeCount : null,
      depthHeatmapEnabled: settings.depthHeatmapEnabled,
      volumeDistributionPriceRange: null,
    },
  });
}

/** 디스크 캔들(mode=candles). sourcePref는 store 값이 아니라 'hogaplay_first' 고정 —
 * store가 'kis_ws_first'/'completeness_first'면 실시간 WS 소스가 선택되는데
 * kiwoom_live 는 캔들을 보유하지만(ADR-0125) venue 축이 있어 축 없는 소스와 다르다.
 * 백엔드 `resolve_candle_source` 가 단일 사다리(kiwoom_live → hogaplay)에서 캔들을 가진
 * 첫 소스를 고른다. 복기뷰 캔들은 항상 디스크 저장분만 쓴다. */
export function studyReferenceCandleRangeOptions(save: StudyViewReference | null) {
  const inputs = studyReferenceQueryInputs(save);
  return rangeBundleQueryOptions({
    code: inputs.candles.code,
    from: inputs.candles.from,
    to: inputs.candles.to,
    timeframe: inputs.candles.timeframe,
    todayKst: null,
    sourcePref: 'hogaplay_first',
    // ⚠ 캔들만 KRX 고정이다 — 위 sourcePref 고정과 같은 이유다. 이 쿼리는 **디스크
    // 저장 캔들 전용**이고 그 승자는 kiwoom_live → hogaplay 인데, hogaplay 는 venue 축이
    // 없다(`SOURCE_HAS_VENUE`). venue 를 넘기면 축 없는 소스에 축을 요구해 쿼리 키만
    // 3벌로 갈리고 응답은 같다.
    venue: 'KRX' as const,
    options: {
      mode: 'candles',
      brokerLateEntriesEnabled: false,
      brokerLateEntryStartHHMM: null,
      volumeDistributionBins: null,
      tradeVolumePocBins: null,
      volumeDistributionPriceRange: null,
    },
  });
}

export function studyReferenceScreenerDailyOptions(
  save: StudyViewReference | null,
  /** 캘린더 봉 맥락 창(`studyDailyContext`). null = 저장 구간만. */
  dailyContext: StudyDailyContextWindow = null,
) {
  const inputs = studyReferenceQueryInputs(save, dailyContext);
  return screenerDailyCandlesQueryOptions(
    inputs.screenerDaily.code,
    inputs.screenerDaily.from,
    inputs.screenerDaily.to,
  );
}

export function studyReferenceQueryOptions(
  save: StudyViewReference | null,
  settings: StudyReferenceQuerySettings,
  /** 캘린더 봉 맥락 창. warm 프리페치도 **같은 값을 넘겨야** 활성 전환 때 키가
   *  맞아 재fetch 가 안 난다(#1216 의 탭 워밍 교훈과 같은 함정). */
  dailyContext: StudyDailyContextWindow = null,
) {
  return {
    rangeHoga: studyReferenceHogaRangeOptions(save, settings),
    rangeSidecars: studyReferenceSidecarRangeOptions(save, settings),
    rangeCandles: studyReferenceCandleRangeOptions(save),
    screenerDaily: studyReferenceScreenerDailyOptions(save, dailyContext),
  };
}
