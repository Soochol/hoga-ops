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

it('예상체결 모드: 가격·등락률 셀이 예상값으로 대체되고 캔들 셀에 마커가 선다', () => {
  row({ expectedPrice: 71500, expectedPct: 2.14 });
  expect(screen.getByTestId('heatmap-row-005930-expected-marker')).toHaveTextContent('예상');
  expect(screen.getByText('71,500')).toBeInTheDocument();
  expect(screen.queryByText('70,000')).not.toBeInTheDocument(); // 확정가는 표시 안 함
  const cell = screen.getByText('+2.14');
  expect(cell).toHaveClass('text-price-up'); // 예상 등락도 방향색 컨벤션 동일
});

it('마감 동시호가(OHLC 살아있음): 마커가 캔들을 대체하지 않고 나란히 선다', () => {
  // 15:20~15:30 은 phase=open 이라 당일 OHLC 가 있다 — 캔들이 정규장 종가·흐름을
  // 계속 보여줘야 예상가가 가격 셀을 덮어도 확정 정보가 남는다.
  const { container } = row({
    open: 69000, high: 71000, low: 68500,
    expectedPrice: 71500, expectedPct: 2.14,
  });
  expect(container.querySelector('.candle-glyph')).toBeInTheDocument();
  expect(screen.getByTestId('heatmap-row-005930-expected-marker')).toBeInTheDocument();
});

it('개장 동시호가(OHLC null): 캔들은 스스로 미렌더되고 마커만 남는다', () => {
  const { container } = row({
    open: null, high: null, low: null,
    expectedPrice: 71500, expectedPct: 2.14,
  });
  expect(container.querySelector('.candle-glyph')).not.toBeInTheDocument();
  expect(screen.getByTestId('heatmap-row-005930-expected-marker')).toBeInTheDocument();
});

it('예상가만 있고 예상 등락률이 없으면 등락 셀은 —', () => {
  row({ expectedPrice: 71500, expectedPct: null });
  expect(screen.getByText('71,500')).toBeInTheDocument();
  expect(screen.getByText('—')).toBeInTheDocument();
});

it('예상값이 없으면(평시) 마커 없이 확정치 그대로 — 기존 모습 불변', () => {
  row({ expectedPrice: null, expectedPct: null });
  expect(screen.queryByTestId('heatmap-row-005930-expected-marker')).not.toBeInTheDocument();
  expect(screen.getByText('70,000')).toBeInTheDocument();
  expect(screen.getByText('+5.00')).toBeInTheDocument();
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
