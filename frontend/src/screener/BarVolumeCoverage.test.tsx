import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BarVolumeCoverage } from './BarVolumeCoverage';

describe('BarVolumeCoverage', () => {
  it('separates causes and counts unique stocks across conditions', () => {
    const { rerender } = render(<BarVolumeCoverage coverage={{ total: 4, complete: 1, incomplete: [
      { code: '0010S0', name: '신규 종목', condition_id: 'A', reason: 'pre_listing_history',
        missing_days: 3, required_from: '2026-09-14', required_to: '2026-09-16' },
      { code: '0010S0', condition_id: 'B', reason: 'pre_listing_history' },
      { code: '005030', condition_id: 'A', reason: 'delisted' },
      { code: '005930', condition_id: 'A', reason: 'collection_missing' },
      { code: '005930', condition_id: 'B', reason: 'calendar_unavailable' },
    ] }} />);
    expect(screen.getByText('이력 부족 3종목').closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText('상장 전 구간 포함 · 비교할 봉 수 부족 · 1종목')).toBeTruthy();
    expect(screen.getByText('상장폐지 이후 구간 · 일봉 없음 · 1종목')).toBeTruthy();
    expect(screen.getByText('공급자에 있는 일봉의 수집 누락 · 보충 필요 · 1종목')).toBeTruthy();
    expect(screen.getByText('거래일 달력 범위 부족 · 1종목')).toBeTruthy();
    expect(screen.getByText('신규 종목 (0010S0) · 3거래일 · 2026-09-14~2026-09-16')).toBeTruthy();
    rerender(<BarVolumeCoverage coverage={{ total: 4, complete: 4, incomplete: [] }} />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('does not turn an old generic history reason into a calendar failure', () => {
    render(<BarVolumeCoverage coverage={{ total: 1, complete: 0, incomplete: [
      { code: '005930', condition_id: 'A', reason: 'missing_history' },
    ] }} />);
    expect(screen.getByText('비교할 봉 이력 부족 · 원인 미확인 · 1종목')).toBeTruthy();
    expect(screen.queryByText(/달력/)).toBeNull();
  });
});
