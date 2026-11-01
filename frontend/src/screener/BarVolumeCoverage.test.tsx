import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BarVolumeCoverage } from './BarVolumeCoverage';

describe('분봉 평가 범위', () => {
  it('실시간 감시가 없어도 평가 불가의 원인과 종목 수를 표시한다', () => {
    render(<BarVolumeCoverage coverage={{ total: 2, complete: 0, incomplete: [
      { code: '005930', condition_id: 'a', reason: 'historical_open_bar_unavailable' },
      { code: '005930', condition_id: 'b', reason: 'historical_open_bar_unavailable' },
      { code: '000660', condition_id: 'a', reason: 'minute_date_mismatch' },
    ] }} />);
    expect(screen.getByRole('status')).toHaveTextContent('대상 2종목 · 전체 조건 평가 가능 0종목 · 확인 필요 2종목');
    expect(screen.getByText('저장된 순위 관측 당시의 진행 중 분봉을 복원할 수 없음: 1종목')).toBeInTheDocument();
    expect(screen.getByText('순위 기준일의 분봉 없음: 1종목')).toBeInTheDocument();
  });
});
