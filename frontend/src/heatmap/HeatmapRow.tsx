import type { DraggableSyntheticListeners } from '@dnd-kit/core';
import { priceDirClass } from '../ui/priceDir';
import { CandleGlyph } from './CandleGlyph';

export interface HeatmapRowProps {
  name: string;
  price: number | null;
  pct: number | null;
  /** 당일 OHLC(없으면 빈 캔들 셀). close 는 기존 price. 부모가 quote 에서 주입. */
  open?: number | null;
  high?: number | null;
  low?: number | null;
  // QuoteRow 와 동일 계약: 이벤트를 통과시켜 호출부가 ctrl/⌘ 로 새 탭 분기를 할 수
  // 있게 한다. 선택적이라 인자 없이 부르던 기존 호출부는 그대로 유효하다.
  onClick: (e?: React.MouseEvent<HTMLDivElement> | React.KeyboardEvent<HTMLDivElement>) => void;
  ariaLabel: string;
  testId: string;
  /** 드래그 재정렬(수동 정렬 모드)용 — manual 모드에서만 SortableHeatmapRow가 채운다.
   *  미전달이면 행은 정적(클릭 전용)이라 change 모드/유닛 테스트와 동일하게 동작한다. */
  sortableRef?: (el: HTMLElement | null) => void;
  sortableStyle?: React.CSSProperties;
  dragListeners?: DraggableSyntheticListeners;
  dragging?: boolean;
  /** 우클릭 컨텍스트 메뉴(삭제·폴더이동, ADR-0068 G3). 미전달이면 기본 컨텍스트 메뉴. */
  onContextMenu?: (e: React.MouseEvent) => void;
}

/** 칼럼형 행: 종목명 │ 캔들 │ 현재가 │ 등락률. 등락은 배경 워시 없이 priceDirClass
 *  텍스트 색(+적/−청/0 중립) + 부호로 표현 — ▲▼ 없음(색+부호 2중, 색약 보조).
 *  결측(null)은 '—'·중립.
 *  종목명 칼럼은 minmax(4rem,1fr) — 좁아져도 4rem 바닥을 깔아 이름이 짜부되지 않게
 *  하고(truncate 의 암묵적 min-width:0 무력화), 남는 폭은 모두 이름에 흘려보낸다.
 *  sortable* props 가 오면 행 루트가 dnd-kit 드래그 표면이 된다(클릭=차트, 드래그=재정렬;
 *  PointerSensor distance:5 가 둘을 가른다 — drawer SortableQuoteRow 와 동일 계약). */
export function HeatmapRow({
  name, price, pct, open, high, low, onClick, ariaLabel, testId,
  sortableRef, sortableStyle, dragListeners, dragging, onContextMenu,
}: HeatmapRowProps) {
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
      onContextMenu={onContextMenu}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e); } }}
      style={dragging ? { ...sortableStyle, opacity: 0.5 } : sortableStyle}
      className={`grid grid-cols-[minmax(4rem,1fr)_2.5rem_3.2rem_4.25rem] gap-1.5 px-2 py-0.5 min-h-list-row items-center text-sm border-b border-border outline-none hover:shadow-[inset_0_0_0_1px_var(--border-strong)] focus-visible:shadow-[inset_0_0_0_1px_var(--accent)] ${draggable ? 'cursor-grab select-none touch-none active:cursor-grabbing' : 'cursor-pointer'}`}
    >
      {/* 종목명은 text-fg-dim(중간 회색) + text-xs(행 text-sm 보다 한 단계 작게) — 현재가·
          등락률 칩보다 낮춰, 이름은 작고 차분하게·숫자는 크게(라벨=이름 < 값=가격 < 신호=칩). */}
      <span className="truncate text-xs text-fg-dim">{name}</span>
      {/* 당일 캔들 셀 — CandleGlyph 가 null 이어도 이 span 이 칼럼을 점유해 정렬 유지. */}
      <span className="flex items-center justify-center overflow-hidden"><CandleGlyph open={open} high={high} low={low} close={price} /></span>
      <span className="text-right font-data tabular-nums text-fg">
        {price === null ? '—' : price.toLocaleString('ko-KR')}
      </span>
      {/* 등락: 방향=priceDirClass 텍스트 색(+적/−청/0 중립) + 부호. 배경 워시·▲▼ 없음
          — 우측 패널 QuoteChange 와 동일 컨벤션(색+부호 2중, 색약 보조). 결측은 '—'. */}
      {pct === null ? (
        <span className="text-right font-data tabular-nums text-fg-dim">—</span>
      ) : (
        <span className={`text-right font-data tabular-nums ${priceDirClass(pct)}`}>
          {sign(pct)}{pct.toFixed(2)}
        </span>
      )}
    </div>
  );
}
