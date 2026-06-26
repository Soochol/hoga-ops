import { describe, expect, it } from 'vitest';
import type { StudyViewReference } from '../api/studyViews';
import type { RangeBundle } from '../api/types';
import { studyActiveViewModel } from './studyActiveViewModel';

const referenceSave: StudyViewReference = {
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

const bundle = {
  code: '005930',
  candles: [{ ts_ms: 1_000 }],
} as unknown as RangeBundle;

describe('studyActiveViewModel', () => {
  it('returns a ready reference model only when both bundles are loaded', () => {
    const model = studyActiveViewModel({
      selectedSave: referenceSave,
      reference: {
        bundle,
        chartBundle: bundle,
        isLoading: false,
        error: null,
        pastDataWarnings: [{ reason: 'partial' }],
      },
    });

    expect(model).toMatchObject({
      status: 'ready',
      variant: 'reference',
      save: referenceSave,
      bundle,
      chartBundle: bundle,
      pastDataWarnings: [{ reason: 'partial' }],
    });
  });

  it('keeps missing reference data as an explicit error state', () => {
    expect(studyActiveViewModel({
      selectedSave: referenceSave,
      reference: {
        bundle,
        chartBundle: null,
        isLoading: false,
        error: null,
        pastDataWarnings: [],
      },
    })).toEqual({ status: 'error' });
  });

  it('returns idle with no selected save', () => {
    expect(studyActiveViewModel({
      selectedSave: null,
      reference: { bundle: null, chartBundle: null, isLoading: false, error: null, pastDataWarnings: [] },
    })).toEqual({ status: 'idle' });
  });
});
