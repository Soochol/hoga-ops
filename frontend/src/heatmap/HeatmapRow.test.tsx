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

it('등락률 칩에 히트 배경(상승=빨강) + 행 자체엔 워시 없음', () => {
  row(); // pct=5 → 상승
  expect(screen.getByText('삼성전자')).toBeInTheDocument();
  expect(screen.getByText('70,000')).toBeInTheDocument();
  // 등락률 칩 = 빨강 히트 배경, 글자는 종목명과 동일하게 text-fg-dim·기본 두께
  // (방향색 텍스트 아님 — text-price-up 금지; 굵은 흰 글자 톤다운).
  const chip = screen.getByText('▲+5.00');
  expect(chip.getAttribute('style') ?? '').toMatch(/220,\s*38,\s*38/);
  expect(chip).not.toHaveClass('text-price-up');
  expect(chip).toHaveClass('text-fg-dim');
  expect(chip).not.toHaveClass('font-semibold');
  // 행 전체 워시 제거 → 행 요소엔 background 인라인 스타일이 없다
  expect(screen.getByTestId('heatmap-row-005930').getAttribute('style') ?? '')
    .not.toMatch(/background/);
});

it('하락 등락률 칩은 파랑 히트', () => {
  row({ pct: -3 });
  expect(screen.getByText('▼-3.00').getAttribute('style') ?? '').toMatch(/37,\s*99,\s*235/);
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

it('series 있으면 스파크라인 셀 렌더(상승=적)', () => {
  row({ series: [1, 2, 3] });
  const path = document.querySelector('.srow-spark path');
  expect(path?.getAttribute('stroke')).toBe('var(--price-up)');
});

it('series 없으면 스파크라인 svg 없음(칸은 유지, 결측 — 개수 불변)', () => {
  row({ price: null, pct: null });
  expect(document.querySelector('.srow-spark')).toBeNull();
  expect(screen.getAllByText('—').length).toBe(2); // 빈 스파크 셀이 '—'를 만들지 않는다
});
