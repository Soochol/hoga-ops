import type { StudyViewReference } from '../api/studyViews';
import { rangeBundleQueryOptions } from '../api/range';
import { screenerDailyCandlesQueryOptions } from '../api/screenerDailyCandles';
import type { LiveVenueOption } from '../state/liveVenue';
import type { SourcePreference } from '../state/sourcePreference';
import { studyReferenceQueryInputs } from './studyReferenceBundleModel';

export type StudyReferenceQuerySettings = {
  sourcePref: SourcePreference;
  /** 복기 거래소 — 공유 `live.venue.v1` 스토어(ADR-0140 §7). */
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
 * kis_live/kiwoom_live는 candles.parquet을 보유하지 않아(ADR-0040/0043) 빈 캔들이 된다.
 * 'hogaplay_first'면 백엔드 resolve_candle_source가 hogaplay → kis_api 복구본(ADR-0109/0121)
 * 순으로 캔들을 고른다(kis_api는 복구 캔들을 보유). 복기뷰 캔들은 항상 디스크 저장분만 쓴다. */
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
    // 저장 캔들 전용**이고 그 승자는 hogaplay → kis_api 복구본인데, 둘 다 venue 축이
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

export function studyReferenceScreenerDailyOptions(save: StudyViewReference | null) {
  const inputs = studyReferenceQueryInputs(save);
  return screenerDailyCandlesQueryOptions(
    inputs.screenerDaily.code,
    inputs.screenerDaily.from,
    inputs.screenerDaily.to,
  );
}

export function studyReferenceQueryOptions(
  save: StudyViewReference | null,
  settings: StudyReferenceQuerySettings,
) {
  return {
    rangeHoga: studyReferenceHogaRangeOptions(save, settings),
    rangeSidecars: studyReferenceSidecarRangeOptions(save, settings),
    rangeCandles: studyReferenceCandleRangeOptions(save),
    screenerDaily: studyReferenceScreenerDailyOptions(save),
  };
}
