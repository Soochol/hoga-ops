import { describe, expect, it } from 'vitest';
import type { StudyViewReference } from '../api/studyViews';
import {
  isReferenceStudyView,
  referenceStudyView,
  studyReferenceDetailPanelTestId,
  studyViewKindLabel,
  studyViewVariant,
} from './studyViewVariant';

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
  it('classifies study views as reference views', () => {
    expect(studyViewVariant(reference)).toBe('reference');
    expect(isReferenceStudyView(reference)).toBe(true);
    expect(referenceStudyView(reference)).toBe(reference);
    expect(studyViewKindLabel(reference)).toBe('복기뷰');
    expect(studyReferenceDetailPanelTestId(reference)).toBe('study-reference-detail-panel');
  });
});
