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

it('±8%↑ 등락률 칩에 히트 배경(상승=빨강) + 행 자체엔 워시 없음', () => {
  row({ pct: 9 }); // 9 ≥ 8 → 상승 색
  expect(screen.getByText('삼성전자')).toBeInTheDocument();
  expect(screen.getByText('70,000')).toBeInTheDocument();
  // 등락률 칩 = 빨강 히트 배경, 글자는 종목명과 동일하게 text-fg-dim·기본 두께
  // (방향색 텍스트 아님 — text-price-up 금지; 굵은 흰 글자 톤다운).
  const chip = screen.getByText('▲+9.00');
  expect(chip.getAttribute('style') ?? '').toMatch(/220,\s*38,\s*38/);
  expect(chip).not.toHaveClass('text-price-up');
  expect(chip).toHaveClass('text-fg-dim');
  expect(chip).not.toHaveClass('font-semibold');
  // 행 전체 워시 제거 → 행 요소엔 background 인라인 스타일이 없다
  expect(screen.getByTestId('heatmap-row-005930').getAttribute('style') ?? '')
    .not.toMatch(/background/);
});

it('하락 ±8%↑ 등락률 칩은 파랑 히트', () => {
  row({ pct: -8 }); // -8 ≤ -8 → 하락 색(정확히 8%도 포함)
  expect(screen.getByText('▼-8.00').getAttribute('style') ?? '').toMatch(/37,\s*99,\s*235/);
});

it('±8% 미만은 배경색 없음(그라데이션 삭제 — 투명)', () => {
  row({ pct: 5 }); // 5 < 8 → 색 없음(이전엔 옅은 빨강이었음)
  const chip = screen.getByText('▲+5.00');
  // 색(rgba/방향 RGB)이 칩 배경에 없어야 한다 — transparent
  expect(chip.getAttribute('style') ?? '').not.toMatch(/rgba|220,\s*38,\s*38|37,\s*99,\s*235/);
  expect(chip).toBeInTheDocument(); // ▲·부호·숫자 표기는 유지(색만 빠짐)
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
