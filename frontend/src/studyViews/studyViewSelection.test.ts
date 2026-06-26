import { describe, expect, it } from 'vitest';
import type { StudyViewReference } from '../api/studyViews';
import { formatStudyTabLabel, latestStudyViewForCode } from './studyViewSelection';

const base = {
  schema_version: 2,
  id: 'a',
  name: '장초반',
  code: '005930',
  label: '삼성전자',
  timeframe: '1m',
  range: { from_date: '20260616', to_date: '20260616', from_ms: 1, to_ms: 2 },
  viewport: { right_edge_ms: 2, bar_span: 120, at_live_edge: false },
  memo: '',
  tags: [],
  created_at_ms: 100,
  updated_at_ms: 100,
} satisfies StudyViewReference;

describe('studyViewSelection', () => {
  it('selects the newest save for a code by updated_at_ms', () => {
    const older = { ...base, id: 'old', updated_at_ms: 200 };
    const newer = { ...base, id: 'new', name: '마감', updated_at_ms: 300 };
    expect(latestStudyViewForCode([older, newer], '005930')?.id).toBe('new');
  });

  it('falls back to created_at_ms when updated_at_ms ties', () => {
    const first = { ...base, id: 'first', updated_at_ms: 300, created_at_ms: 100 };
    const second = { ...base, id: 'second', updated_at_ms: 300, created_at_ms: 200 };
    expect(latestStudyViewForCode([first, second], '005930')?.id).toBe('second');
  });

  it('returns null when the code has no saved study view', () => {
    expect(latestStudyViewForCode([base], '000660')).toBeNull();
  });

  it('formats study tab labels with stock and timeframe context', () => {
    expect(formatStudyTabLabel(base)).toBe('삼성전자 · 장초반 · 1m');
  });
});
