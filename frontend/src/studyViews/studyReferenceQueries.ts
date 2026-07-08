import type { StudyViewReference } from '../api/studyViews';
import { rangeBundleQueryOptions } from '../api/range';
import { screenerDailyCandlesQueryOptions } from '../api/screenerDailyCandles';
import type { SourcePreference } from '../state/sourcePreference';
import { studyReferenceQueryInputs } from './studyReferenceBundleModel';

export type StudyReferenceQuerySettings = {
  sourcePref: SourcePreference;
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
 * store가 'kis_ws_first'면 candles.parquet이 없는 kis_live 소스가 선택돼 빈 캔들이 된다
 * (kis_live/kis_api는 캔들 parquet 미보유). 복기뷰 캔들은 항상 디스크 캡처만 쓴다. */
export function studyReferenceCandleRangeOptions(save: StudyViewReference | null) {
  const inputs = studyReferenceQueryInputs(save);
  return rangeBundleQueryOptions({
    code: inputs.candles.code,
    from: inputs.candles.from,
    to: inputs.candles.to,
    timeframe: inputs.candles.timeframe,
    todayKst: null,
    sourcePref: 'hogaplay_first',
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
