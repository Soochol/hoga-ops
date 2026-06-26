import type { StudyViewReference } from '../api/studyViews';
import { rangeBundleQueryOptions } from '../api/range';
import {
  studyPastCandlesQueryOptions,
  studyPastDailyCandlesQueryOptions,
} from '../api/studyPastCandles';
import type { LiveVenueOption } from '../state/liveVenue';
import type { SourcePreference } from '../state/sourcePreference';
import { studyReferenceQueryInputs } from './studyReferenceBundleModel';

export type StudyReferenceQuerySettings = {
  venue: LiveVenueOption;
  sourcePref: SourcePreference;
  volumeDistributionEnabled: boolean;
  tradeVolumePocEnabled: boolean;
  volumeDistributionRangeCount: number;
};

export function studyReferenceRangeOptions(
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
      volumeDistributionBins: settings.volumeDistributionEnabled ? settings.volumeDistributionRangeCount : null,
      tradeVolumePocBins: settings.tradeVolumePocEnabled ? settings.volumeDistributionRangeCount : null,
      volumeDistributionPriceRange: null,
    },
  });
}

export function studyReferenceMinuteCandlesOptions(
  save: StudyViewReference | null,
  settings: StudyReferenceQuerySettings,
) {
  const inputs = studyReferenceQueryInputs(save);
  return studyPastCandlesQueryOptions(
    inputs.minuteCandles.code,
    inputs.minuteCandles.from,
    inputs.minuteCandles.to,
    settings.venue,
  );
}

export function studyReferenceDailyCandlesOptions(
  save: StudyViewReference | null,
  settings: StudyReferenceQuerySettings,
) {
  const inputs = studyReferenceQueryInputs(save);
  return studyPastDailyCandlesQueryOptions(
    inputs.dailyCandles.code,
    inputs.dailyCandles.from,
    inputs.dailyCandles.to,
    settings.venue,
  );
}

export function studyReferenceQueryOptions(
  save: StudyViewReference | null,
  settings: StudyReferenceQuerySettings,
) {
  return {
    range: studyReferenceRangeOptions(save, settings),
    minuteCandles: studyReferenceMinuteCandlesOptions(save, settings),
    dailyCandles: studyReferenceDailyCandlesOptions(save, settings),
  };
}
