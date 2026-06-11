import type { DraggableSyntheticListeners } from '@dnd-kit/core';
import { heatBg, HEAT_CHIP_MAX_ALPHA } from './heat';

export interface HeatmapRowProps {
  name: string;
  price: number | null;
  pct: number | null;
  onClick: () => void;
  ariaLabel: string;
  testId: string;
  /** 드래그 재정렬(수동 정렬 모드)용 — manual 모드에서만 SortableHeatmapRow가 채운다.
   *  미전달이면 행은 정적(클릭 전용)이라 change 모드/유닛 테스트와 동일하게 동작한다. */
  sortableRef?: (el: HTMLElement | null) => void;
  sortableStyle?: React.CSSProperties;
  dragListeners?: DraggableSyntheticListeners;
  dragging?: boolean;
}

/** 칼럼형 행: 종목명 │ 현재가 │ 등락률 칩. 히트색은 등락률 칩 배경에만 적용한다
 *  (행 전체 워시 X) — 종목명·현재가는 카드 배경 + 흰 글자로 항상 또렷하고, 색은
 *  의미 있는 등락률에만 모인다. 칩 = 농도(heatBg)·흰 글자·▲▼·부호의 4중 표현
 *  (색약 보조). 결측(null)은 '—'·중립.
 *  종목명 칼럼은 minmax(4rem,1fr) — 좁아져도 4rem 바닥을 깔아 이름이 짜부되지 않게
 *  하고(truncate 의 암묵적 min-width:0 무력화), 남는 폭은 모두 이름에 흘려보낸다.
 *  sortable* props 가 오면 행 루트가 dnd-kit 드래그 표면이 된다(클릭=차트, 드래그=재정렬;
 *  PointerSensor distance:5 가 둘을 가른다 — drawer SortableQuoteRow 와 동일 계약). */
export function HeatmapRow({
  name, price, pct, onClick, ariaLabel, testId,
  sortableRef, sortableStyle, dragListeners, dragging,
}: HeatmapRowProps) {
  const glyph = pct === null ? '' : pct > 0 ? '▲' : pct < 0 ? '▼' : '';
  const sign = (n: number) => (n > 0 ? '+' : '');
  const draggable = !!dragListeners;
  return (
    <div
      ref={sortableRef}
      role="button"
      tabIndex={0}
      data-testid={testId}
      aria-label={ariaLabel}
      // dragListeners 를 핸들러보다 먼저 펼쳐, 행의 클릭/Enter=차트 열기 핸들러가 항상
      // 우선되게 한다(현 PointerSensor 는 onPointerDown 만 — 충돌 없음; 향후 KeyboardSensor
      // 도입 시에도 Enter/Space 가 드래그가 아닌 차트 열기로 유지되도록 하는 방어).
      {...dragListeners}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      style={dragging ? { ...sortableStyle, opacity: 0.5 } : sortableStyle}
      className={`grid grid-cols-[minmax(4rem,1fr)_3.2rem_4.25rem] gap-1.5 px-2 py-0.5 items-center text-sm border-b border-border outline-none hover:shadow-[inset_0_0_0_1px_var(--border-strong)] focus-visible:shadow-[inset_0_0_0_1px_var(--accent)] ${draggable ? 'cursor-grab select-none touch-none active:cursor-grabbing' : 'cursor-pointer'}`}
    >
      {/* 종목명은 text-fg-dim(중간 회색) — 현재가·등락률 칩보다 한 단계 낮춰, 흰 글자
          일색으로 너무 밝던 행에 위계를 준다(라벨=이름 < 값=가격 < 신호=등락률 칩). */}
      <span className="truncate text-fg-dim">{name}</span>
      <span className="text-right font-mono tabular-nums text-fg">
        {price === null ? '—' : price.toLocaleString('ko-KR')}
      </span>
      {/* 히트는 등락률 칩 배경에만: 농도=등락폭(heatBg, 칩 전용 알파) + ▲▼ + 부호.
          칸을 꽉 채우는 둥근 칩이라 한 칼럼이 통째로 히트색 띠처럼 보이고 행 간 정렬도 유지된다.
          글자는 종목명과 동일하게 text-fg-dim·기본 두께 — 칩의 색(방향·농도)이 신호를 지고
          숫자는 한 단계 물러난 디테일로 둔다(사용자 선호: 굵은 흰 글자 톤다운). */}
      {pct === null ? (
        <span className="text-right font-mono tabular-nums text-fg-dim">—</span>
      ) : (
        <span
          className="rounded px-1.5 text-right font-mono tabular-nums text-fg-dim"
          style={{ background: heatBg(pct, HEAT_CHIP_MAX_ALPHA) }}
        >
          {glyph}{sign(pct)}{pct.toFixed(2)}
        </span>
      )}
    </div>
  );
}
