import type { StudyViewReference } from '../api/studyViews';
import { rangeBundleQueryOptions } from '../api/range';
import { screenerDailyCandlesQueryOptions } from '../api/screenerDailyCandles';
import type { LiveVenueOption } from '../state/liveVenue';
import type { SourcePreference } from '../state/sourcePreference';
import { studyReferenceQueryInputs } from './studyReferenceBundleModel';
import type { StudyDailyContextWindow } from './studyDailyContext';

export type StudyReferenceQuerySettings = {
  /** undefined = 설정 로딩 중 → `rangeBundleQueryOptions` 가 `enabled=false` 로 막는다. */
  sourcePref: SourcePreference | undefined;
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
      brokerLateEntriesEnabled: settings.brokerLateEntryEnabled,
      brokerLateEntryStartHHMM: settings.brokerLateEntryEnabled ? settings.brokerLateEntryStartHHMM : null,
      volumeDistributionBins: settings.volumeDistributionEnabled ? settings.volumeDistributionRangeCount : null,
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
