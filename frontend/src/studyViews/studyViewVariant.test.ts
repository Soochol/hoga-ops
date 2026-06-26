import { describe, expect, it } from 'vitest';
import type {
  ParquetStudyView,
  StudyViewReference,
} from '../api/studyViews';
import {
  isLegacyStudySnapshotView,
  isReferenceStudyView,
  legacyStudySnapshotId,
  referenceStudyView,
  studyReferenceDetailPanelTestId,
  studyViewKindLabel,
  studyViewVariant,
} from './studyViewVariant';

const legacy = {
  id: 'legacy1',
  name: '스냅샷',
  code: '005930',
  label: '삼성전자',
  timeframe: '5m',
  memo: '',
  tags: [],
} as unknown as ParquetStudyView;

const reference: StudyViewReference = {
  schema_version: 2,
  id: 'ref1',
  name: '복기',
  code: '005930',
  label: '삼성전자',
  timeframe: '5m',
  range: { from_date: '20260616', to_date: '20260618', from_ms: 1_000, to_ms: 2_000 },
  viewport: { right_edge_ms: 2_000, bar_span: 120, at_live_edge: false },
  memo: '',
  tags: [],
  created_at_ms: 1,
  updated_at_ms: 2,
};

describe('studyViewVariant', () => {
  it('classifies reference and legacy study views', () => {
    expect(studyViewVariant(reference)).toBe('reference');
    expect(studyViewVariant(legacy)).toBe('legacy-snapshot');
    expect(isReferenceStudyView(reference)).toBe(true);
    expect(isReferenceStudyView(legacy)).toBe(false);
    expect(isLegacyStudySnapshotView(legacy)).toBe(true);
    expect(isLegacyStudySnapshotView(reference)).toBe(false);
  });

  it('exposes variant-specific rendering policy', () => {
    expect(referenceStudyView(reference)).toBe(reference);
    expect(referenceStudyView(legacy)).toBeNull();
    expect(legacyStudySnapshotId(legacy)).toBe('legacy1');
    expect(legacyStudySnapshotId(reference)).toBeNull();
    expect(studyViewKindLabel(reference)).toBe('복기뷰');
    expect(studyViewKindLabel(legacy)).toBe('저장 스냅샷');
    expect(studyReferenceDetailPanelTestId(reference)).toBe('study-reference-detail-panel');
    expect(studyReferenceDetailPanelTestId(legacy)).toBeUndefined();
  });

});
