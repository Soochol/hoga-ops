import type { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core';
import { dispositionFromMouseEvent, type LiveOpenDisposition } from '../live/liveActivation';
import { priceDirClass } from '../ui/priceDir';

/** 관심종목·스크리너 드로어 공용 행: 종목명(좌) │ 현재가(+등락률)(우) │ (선택) 트레일링 액션.
 *  ScreenerResultRow 의 시각/키보드 계약을 그대로 가져오고 quote 셀을 우측에 둔다.
 *  trailingAction: 패널이 주입하는 행 우측 affordance(하트/휴지통). 자체적으로
 *  stopPropagation/aria 를 책임진다. <li> 는 group 이라 액션이 group-hover/
 *  group-focus-within 로 등장 처리를 할 수 있다. */
export interface QuoteRowProps {
  name: string;
  price: number | null;
  pct: number | null;
  changeWon: number | null;
  active: boolean;
  ariaLabel: string;
  testId: string;
  onClick: (options?: { disposition?: LiveOpenDisposition }) => void;
  trailingAction?: React.ReactNode;
  // --- drag (선택 패널용; 미전달 시 비-드래그 동작) ---
  sortableRef?: (node: HTMLElement | null) => void;
  sortableStyle?: Pick<React.CSSProperties, 'transform' | 'transition'>;
  dragListeners?: DraggableSyntheticListeners;
  dragAttributes?: DraggableAttributes;
  dragging?: boolean;
  // --- 관심종목 패널 전용 우클릭/Delete (미전달 시 무동작) ---
  onContextMenu?: (e: React.MouseEvent<HTMLLIElement>) => void;
  onDelete?: () => void;
  // --- 관심종목 패널 전용 들여쓰기: 그룹 헤더의 chevron-left 구조에서 종목명이
  // 그룹명 첫 글자(≈46px)보다 왼쪽에서 시작해 위계가 역전되는 것을 교정.
  // pl-10(50px) > 라벨 시작. 그룹 없는 스크리너는 미전달(평면 목록, 폭 절약). ---
  indented?: boolean;
}

function formatPct(pct: number | null): string {
  if (pct === null) return '—';
  return `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

export function QuoteRow({
  name, price, pct, changeWon: _changeWon, active, ariaLabel, testId, onClick, trailingAction,
  sortableRef, sortableStyle, dragListeners, dragAttributes, dragging,
  onContextMenu, onDelete, indented,
}: QuoteRowProps) {
  void _changeWon;
  const onKeyDown = (e: React.KeyboardEvent<HTMLLIElement>) => {
    // 중첩 버튼(trailingAction)에서 올라온 keydown 은 무시 — 행이 직접
    // 포커스됐을 때만 동작한다.
    if (e.target !== e.currentTarget) return;
    // Delete 만 삭제 트리거 — Backspace 는 뒤로가기/문자삭제 머슬메모리와 충돌하는
    // 파괴적 오발동이라 제외(undo 없음).
    if (onDelete && e.key === 'Delete') {
      e.preventDefault();
      // 삭제는 비낙관적(invalidate 기반)이라 행이 잠시 뒤 언마운트된다. 인접 행으로
      // 먼저 포커스를 옮겨 두면 언마운트 시 포커스가 <body> 로 떨어지지 않는다.
      const li = e.currentTarget;
      const sibling = (li.nextElementSibling ?? li.previousElementSibling) as HTMLElement | null;
      sibling?.focus();
      onDelete();
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
  };
  return (
    <li
      ref={sortableRef}
      data-testid={testId}
      role="button"
      tabIndex={0}
      aria-current={active ? 'true' : undefined}
      aria-label={ariaLabel}
      aria-keyshortcuts={onDelete ? 'Delete' : undefined}
      onClick={(e) => onClick({ disposition: dispositionFromMouseEvent(e) })}
      onKeyDown={onKeyDown}
      onContextMenu={onContextMenu}
      className={`group cursor-pointer ${indented ? 'pl-10' : 'pl-md'} pr-md py-sm flex items-center gap-2 border-b outline-none hover:bg-bg-input-hover focus-visible:bg-bg-input-hover`}
      style={{
        background: active ? 'var(--tint-selection)' : 'transparent',
        borderLeft: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
        ...sortableStyle,
        ...(dragging ? { opacity: 0.6, cursor: 'grabbing', zIndex: 1, position: 'relative' } : {}),
      }}
    >
      {dragListeners && (
        <span
          {...dragAttributes}
          {...dragListeners}
          data-testid={`drag-handle-${testId}`}
          aria-label={`${name} 순서 이동`}
          onClick={(e) => e.stopPropagation()}
          className="flex-none -ml-1 h-5 w-4 cursor-grab select-none touch-none grid place-items-center text-fg-dimmer opacity-70 hover:opacity-100 hover:text-fg active:cursor-grabbing"
        >
          ⠿
        </span>
      )}
      {/* 종목명은 가격(text-sm)보다 의도적으로 작게(text-xs) — 그룹 헤더(text-sm/600) >
          종목명 크기 위계 + 가격이 1차 콘텐츠. 등락(text-xs)과는 서체(mono)·색으로 구분. */}
      <span className="flex-1 min-w-0 leading-tight">
        <span className="truncate text-xs text-fg">{name}</span>
      </span>
      <span className={`font-mono tabular-nums text-sm text-right leading-tight ${pct === null ? 'text-fg' : priceDirClass(pct)}`}>
        {price != null ? `${price.toLocaleString('ko-KR')}원` : '—'} ({formatPct(pct)})
      </span>
      {trailingAction != null && (
        <span className="flex items-center justify-center" style={{ minWidth: '1.25rem' }}>
          {trailingAction}
        </span>
      )}
    </li>
  );
}
