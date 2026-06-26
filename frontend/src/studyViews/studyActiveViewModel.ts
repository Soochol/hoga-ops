import type { StudyViewListRow, StudyViewReference } from '../api/studyViews';
import type { RangeBundle } from '../api/types';
import type { LiveDataWarning } from '../live/liveDataWarnings';
import { referenceStudyView } from './studyViewVariant';

export type StudyReferenceBundleState = {
  bundle: RangeBundle | null | undefined;
  chartBundle: RangeBundle | null | undefined;
  isLoading: boolean;
  error: unknown;
  pastDataWarnings: LiveDataWarning[];
};

export type StudyActiveViewModel =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error' }
  | {
    status: 'ready';
    variant: 'reference';
    save: StudyViewReference;
    bundle: RangeBundle;
    chartBundle: RangeBundle;
    pastDataWarnings: LiveDataWarning[];
  };

export function studyActiveViewModel({
  selectedSave,
  reference,
}: {
  selectedSave: StudyViewListRow | null | undefined;
  reference: StudyReferenceBundleState;
}): StudyActiveViewModel {
  if (!selectedSave) return { status: 'idle' };

  const referenceSave = referenceStudyView(selectedSave);
  if (referenceSave) {
    if (reference.isLoading) return { status: 'loading' };
    if (reference.error || !reference.bundle || !reference.chartBundle) return { status: 'error' };
    return {
      status: 'ready',
      variant: 'reference',
      save: referenceSave,
      bundle: reference.bundle,
      chartBundle: reference.chartBundle,
      pastDataWarnings: reference.pastDataWarnings,
    };
  }

  return { status: 'error' };
}
