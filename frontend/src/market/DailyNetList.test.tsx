import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DailyNetList } from './DailyNetList';
import { formatMarketDate } from './marketFormat';
import { todayKstYyyymmdd } from '../live/liveDateTime';

describe('DailyNetList', () => {
  it('marks today provisional only when the caller supplies provisional data', () => {
    const rows = [{ date: todayKstYyyymmdd(), values: [100] }];
    const { rerender } = render(<DailyNetList label="투자자" columns={['외국인']} rows={rows} />);
    expect(screen.queryByText('잠정')).not.toBeInTheDocument();
    rerender(<DailyNetList todayProvisional label="프로그램" columns={['합계']} rows={rows} />);
    expect(screen.getByText('잠정')).toBeInTheDocument();
  });

  it('sorts newest first, preserves signs and zero, and shows period totals', () => {
    render(<DailyNetList label="투자자" columns={['외국인', '기관']} rows={[
      { date: '20260813000000', values: [100, -50] },
      { date: '20260814', values: [-25, 0] },
    ]} />);
    const rows = within(screen.getByRole('table')).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('08/14-250');
    expect(rows[2]).toHaveTextContent('08/13+100-50');
    expect(rows[3]).toHaveTextContent('기간 합계+75-50');
    expect(screen.getByRole('table')).toHaveAccessibleName('투자자 · 단위 억원');
  });

  it('uses the supplied program total and never treats missing values as zero', () => {
    render(<DailyNetList label="프로그램" columns={['차익', '비차익', '합계']} rows={[
      { date: '20260813', values: [100, null, 49] },
      { date: '20260814', values: [0, -10, -10] },
    ]} />);
    const rows = within(screen.getByRole('table')).getAllByRole('row');
    expect(rows[2]).toHaveTextContent('08/13+100—+49');
    expect(rows[3]).toHaveTextContent('기간 합계+100—+39');
    expect(within(rows[3]).getByTitle(/누락된 값/)).toHaveTextContent('—');
  });

  it('formats date-only and vendor datetime values', () => {
    expect(formatMarketDate('20260813000000')).toBe('08/13');
    expect(formatMarketDate('20260813')).toBe('08/13');
    expect(formatMarketDate('unknown')).toBe('unknown');
  });
});
