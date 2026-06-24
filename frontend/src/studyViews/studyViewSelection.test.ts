import { describe, expect, it } from 'vitest';
import type { ParquetStudyView } from '../api/studyViews';
import { formatStudyTabLabel, latestStudyViewForCode } from './studyViewSelection';

const base = {
  id: 'a',
  name: '장초반',
  code: '005930',
  label: '삼성전자',
  timeframe: '1m',
  snapshot_from_ms: 1,
  snapshot_to_ms: 2,
  viewport: { right_edge_ms: 2, bar_span: 120, at_live_edge: false },
  indicator_state: {
    volume_enabled: true,
    quote_totals_enabled: true,
    ratio_enabled: true,
    fill_strength_enabled: true,
    aggregation_basis: 'close',
    auction_window_mask: true,
    ratio_outlier_filter_enabled: false,
    ratio_outlier_threshold: 50,
  },
  memo: '',
  tags: [],
  provenance: { saved_from_route: '/live', data_provenance: 'live_mixed' },
  snapshot_schema_version: 1,
  snapshot_path: '',
  snapshot_size_bytes: 1,
  created_at_ms: 100,
  updated_at_ms: 100,
} satisfies ParquetStudyView;

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
