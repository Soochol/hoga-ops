import type { StudyViewListRow, StudyViewReference } from '../api/studyViews';

export type StudyViewVariant = 'reference';

export function studyViewVariant(_row: StudyViewListRow): StudyViewVariant {
  return 'reference';
}

export function isReferenceStudyView(row: StudyViewListRow | null | undefined): row is StudyViewReference {
  return row?.schema_version === 2;
}

export function referenceStudyView(row: StudyViewListRow | null | undefined): StudyViewReference | null {
  return isReferenceStudyView(row) ? row : null;
}

export function studyViewKindLabel(_row: StudyViewListRow): string {
  return '복기뷰';
}

export function studyReferenceDetailPanelTestId(row: StudyViewListRow | null | undefined): string | undefined {
  return isReferenceStudyView(row) ? 'study-reference-detail-panel' : undefined;
}
