import { describe, expect, it } from 'vitest';
import { savedRangeAppliesTo, savedRangeCalendarFrom, savedRangeFocusFromView } from './savedRangeFocus';
import type { StudyViewListRow } from '../api/studyViews';
import type { SavedRangeFocus } from '../state/livePage';

const focus = (extra: Partial<SavedRangeFocus> = {}): SavedRangeFocus => ({
  viewId: 'v1', code: '005930', label: '삼성전자',
  fromMs: 1, toMs: 2, fromDate: '20240301', toDate: '20240305',
  savedTimeframe: 'D', savedBarSpan: 40, ...extra,
});

describe('savedRangeAppliesTo — freeze · venue 고정 · 기간 칩이 공유하는 술어', () => {
  it('슬롯이 없거나 다른 종목이면 대상이 아니다', () => {
    expect(savedRangeAppliesTo(null, '005930', 'D')).toBe(false);
    expect(savedRangeAppliesTo(focus(), '000660', 'D')).toBe(false);
  });

  it('저장뷰 구간은 분봉에서도 산다 — 「일봉 밴드와 분봉 벽은 같은 슬롯의 두 표현」', () => {
    expect(savedRangeAppliesTo(focus(), '005930', 'D')).toBe(true);
    expect(savedRangeAppliesTo(focus(), '005930', '1m')).toBe(true);
  });

  it('일봉 전용 구간은 **분봉에서 존재하지 않는다** — 그 날의 분봉이 디스크에 없다', () => {
    const f = focus({ dailyOnly: true });
    expect(savedRangeAppliesTo(f, '005930', 'D')).toBe(true);
    expect(savedRangeAppliesTo(f, '005930', 'W')).toBe(true);
    // 분봉 창은 freeze 도 venue 고정도 칩도 받지 않는다 — 셋이 이 한 줄에 달려 있다.
    expect(savedRangeAppliesTo(f, '005930', '1m')).toBe(false);
    expect(savedRangeAppliesTo(f, '005930', '60m')).toBe(false);
  });
});

it('requests calendar context before an old saved date and leaves intraday paths alone', async () => {
  const { savedRangeCalendarFrom } = await import('./savedRangeFocus');
  const from = savedRangeCalendarFrom(focus({ fromDate: '20210422' }), 'D');
  expect(from).not.toBeNull();
  expect(from! < '20210422').toBe(true);
  expect(savedRangeCalendarFrom(null, 'D')).toBeNull();
  expect(savedRangeCalendarFrom(focus(), '1m')).toBeNull();
  expect(savedRangeCalendarFrom(focus(), '5s')).toBeNull();
});

it('includes a wide saved viewport left edge only for its own timeframe', () => {
  const savedLeftEdgeMs = Date.UTC(2015, 0, 1);
  const f = focus({ fromDate: '20210422', savedLeftEdgeMs });
  expect(savedRangeCalendarFrom(f, 'D')).toBe('20150101');
  expect(savedRangeCalendarFrom(f, 'W')).toBe(savedRangeCalendarFrom(focus({ fromDate: '20210422' }), 'W'));
});

it('carries an optional saved left edge without adding one to legacy rows', () => {
  const row = { id: 'v', code: '005930', label: '삼성전자', timeframe: 'D',
    range: { from_ms: 1, to_ms: 2, from_date: '20210422', to_date: '20210422' },
    viewport: { bar_span: 191.47, right_edge_ms: 2, at_live_edge: false } } as StudyViewListRow;
  expect(savedRangeFocusFromView(row)).not.toHaveProperty('savedLeftEdgeMs');
  expect(savedRangeFocusFromView({ ...row, viewport: { ...row.viewport, left_edge_ms: 1 } })).toHaveProperty('savedLeftEdgeMs', 1);
});
