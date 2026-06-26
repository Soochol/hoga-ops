import type {
  ParquetStudyView,
  StudyViewListRow,
  StudyViewReference,
} from '../api/studyViews';

export type StudyViewVariant = 'reference' | 'legacy-snapshot';

export function studyViewVariant(row: StudyViewListRow): StudyViewVariant {
  return row.schema_version === 2 ? 'reference' : 'legacy-snapshot';
}

export function isReferenceStudyView(row: StudyViewListRow | null | undefined): row is StudyViewReference {
  return row?.schema_version === 2;
}

export function isLegacyStudySnapshotView(row: StudyViewListRow | null | undefined): row is ParquetStudyView {
  return !!row && !isReferenceStudyView(row);
}

export function referenceStudyView(row: StudyViewListRow | null | undefined): StudyViewReference | null {
  return isReferenceStudyView(row) ? row : null;
}

export function legacyStudySnapshotId(row: StudyViewListRow | null | undefined): string | null {
  return isLegacyStudySnapshotView(row) ? row.id : null;
}

export function studyViewKindLabel(row: StudyViewListRow): string {
  return studyViewVariant(row) === 'reference' ? '복기뷰' : '저장 스냅샷';
}

export function studyReferenceDetailPanelTestId(row: StudyViewListRow | null | undefined): string | undefined {
  return isReferenceStudyView(row) ? 'study-reference-detail-panel' : undefined;
}
