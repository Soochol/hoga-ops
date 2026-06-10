import { render, screen, fireEvent } from '@testing-library/react';
import { it, expect, vi } from 'vitest';
import { HeatmapRow } from './HeatmapRow';

function row(props: Partial<React.ComponentProps<typeof HeatmapRow>> = {}) {
  return render(
    <HeatmapRow
      name="삼성전자" price={70000} pct={5}
      onClick={() => {}} ariaLabel="삼성전자 005930 차트 열기" testId="heatmap-row-005930"
      {...props}
    />,
  );
}

it('등락률·현재가 렌더, 상승=price-up 색', () => {
  row();
  expect(screen.getByText('삼성전자')).toBeInTheDocument();
  expect(screen.getByText('70,000')).toBeInTheDocument();
  expect(screen.getByText('▲+5.00')).toHaveClass('text-price-up');
});

it('시세 결측(null) → 가격·등락 모두 —', () => {
  row({ price: null, pct: null });
  expect(screen.getAllByText('—').length).toBe(2);
});

it('클릭 시 onClick 호출', () => {
  const onClick = vi.fn();
  row({ onClick });
  fireEvent.click(screen.getByTestId('heatmap-row-005930'));
  expect(onClick).toHaveBeenCalledOnce();
});
