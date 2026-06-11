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

it('상승 등락률 = 빨강 텍스트(text-price-up), 화살표·배경 없음', () => {
  row({ pct: 9 });
  expect(screen.getByText('삼성전자')).toBeInTheDocument();
  expect(screen.getByText('70,000')).toBeInTheDocument();
  const cell = screen.getByText('+9.00');
  expect(cell).toHaveClass('text-price-up');
  expect(cell.textContent).not.toMatch(/[▲▼]/);
  expect(cell.getAttribute('style') ?? '').not.toMatch(/background|rgba/);
  // 행 자체에도 배경 인라인 없음
  expect(screen.getByTestId('heatmap-row-005930').getAttribute('style') ?? '')
    .not.toMatch(/background/);
});

it('하락 등락률 = 파랑 텍스트(text-price-down), 화살표 없음', () => {
  row({ pct: -8 });
  const cell = screen.getByText('-8.00');
  expect(cell).toHaveClass('text-price-down');
  expect(cell.textContent).not.toMatch(/[▲▼]/);
});

it('보합 0% = 중립 text-fg-dim, 부호 없음', () => {
  row({ pct: 0 });
  const cell = screen.getByText('0.00');
  expect(cell).toHaveClass('text-fg-dim');
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

it('sortable 모드: dragListeners 가 행 루트로 전파 + grab 커서(드래그 표면)', () => {
  const onPointerDown = vi.fn();
  row({ dragListeners: { onPointerDown }, dragging: false });
  const rowEl = screen.getByTestId('heatmap-row-005930');
  expect(rowEl).toHaveClass('cursor-grab');
  fireEvent.pointerDown(rowEl);
  expect(onPointerDown).toHaveBeenCalled();
});

it('정적(클릭 전용) 모드: dragListeners 없으면 cursor-pointer, grab 아님', () => {
  row();
  const rowEl = screen.getByTestId('heatmap-row-005930');
  expect(rowEl).toHaveClass('cursor-pointer');
  expect(rowEl).not.toHaveClass('cursor-grab');
});

it('OHLC 있으면 캔들 셀 렌더(양봉=적)', () => {
  row({ price: 115, open: 100, high: 120, low: 95 }); // close=115>open=100 → 양봉
  const fill = document.querySelector('.candle-glyph rect:last-child')?.getAttribute('fill');
  expect(fill).toBe('var(--price-up)');
});

it('OHLC 결측이면 캔들 없음(칸 유지, 결측 — 개수 불변)', () => {
  row({ price: null, pct: null }); // open/high/low 미전달 → null
  expect(document.querySelector('.candle-glyph')).toBeNull();
  expect(screen.getAllByText('—').length).toBe(2); // 빈 캔들 셀이 '—'를 만들지 않는다
});
