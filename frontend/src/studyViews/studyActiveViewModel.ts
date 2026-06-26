import type { ParquetStudySnapshot, StudyViewListRow, StudyViewReference } from '../api/studyViews';
import type { RangeBundle } from '../api/types';
import type { LiveDataWarning } from '../live/liveDataWarnings';
import {
  studySnapshotRenderModel,
  type StudySnapshotRenderModel,
} from './studySnapshotAdapter';
import { referenceStudyView } from './studyViewVariant';

export type StudyReferenceBundleState = {
  bundle: RangeBundle | null | undefined;
  chartBundle: RangeBundle | null | undefined;
  isLoading: boolean;
  error: unknown;
  pastDataWarnings: LiveDataWarning[];
};

export type StudySnapshotState = {
  snapshot: ParquetStudySnapshot | null | undefined;
  isLoading: boolean;
  isError: boolean;
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
  }
  | {
    status: 'ready';
    variant: 'legacy-snapshot';
    save: StudyViewListRow;
    snapshot: ParquetStudySnapshot;
    renderModel: StudySnapshotRenderModel;
  };

export function studyActiveViewModel({
  selectedSave,
  reference,
  snapshot,
}: {
  selectedSave: StudyViewListRow | null | undefined;
  reference: StudyReferenceBundleState;
  snapshot: StudySnapshotState;
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

  if (snapshot.isLoading) return { status: 'loading' };
  if (snapshot.isError || !snapshot.snapshot) return { status: 'error' };
  return {
    status: 'ready',
    variant: 'legacy-snapshot',
    save: selectedSave,
    snapshot: snapshot.snapshot,
    renderModel: studySnapshotRenderModel(snapshot.snapshot),
  };
}
