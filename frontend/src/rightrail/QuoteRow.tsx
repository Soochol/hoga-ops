import type { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core';
import { QuoteChange } from './QuoteChange';

/** 관심종목·스크리너 드로어 공용 행: 종목명(좌) │ 현재가·전일대비 2줄 스택(우) │ (선택) 트레일링 액션.
 *  ScreenerResultRow 의 시각/키보드 계약을 그대로 가져오고 현재가+등락 셀을 우측에 스택.
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
  onClick: () => void;
  trailingAction?: React.ReactNode;
  // --- drag (관심종목 패널 전용; 미전달 시 비-드래그 동작) ---
  sortableRef?: (node: HTMLElement | null) => void;
  sortableStyle?: Pick<React.CSSProperties, 'transform' | 'transition'>;
  dragListeners?: DraggableSyntheticListeners;
  dragAttributes?: DraggableAttributes;
  dragging?: boolean;
  // --- 관심종목 패널 전용 우클릭/Delete (미전달 시 무동작) ---
  onContextMenu?: (e: React.MouseEvent<HTMLLIElement>) => void;
  onDelete?: () => void;
}

export function QuoteRow({
  name, price, pct, changeWon, active, ariaLabel, testId, onClick, trailingAction,
  sortableRef, sortableStyle, dragListeners, dragAttributes, dragging,
  onContextMenu, onDelete,
}: QuoteRowProps) {
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
    // dragAttributes/dragListeners 를 명시 핸들러보다 먼저 스프레드한다 — 그래야
    // 아래 onClick/onKeyDown/onContextMenu(우리 것)가 dnd-kit 이 같은 이름으로 주는
    // 핸들러를 항상 덮는다. 현재는 PointerSensor 만이라 listeners=onPointerDown 뿐이나,
    // 훗날 KeyboardSensor 추가 시 onKeyDown 충돌(Enter/Delete 무력화)을 미연에 막는다.
    <li
      ref={sortableRef}
      {...dragAttributes}
      {...dragListeners}
      data-testid={testId}
      role="button"
      tabIndex={0}
      aria-current={active ? 'true' : undefined}
      aria-label={ariaLabel}
      aria-keyshortcuts={onDelete ? 'Delete' : undefined}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onContextMenu={onContextMenu}
      className="group cursor-pointer px-md py-sm flex items-center gap-2 border-b outline-none hover:bg-bg-input-hover focus-visible:bg-bg-input-hover"
      style={{
        background: active ? 'var(--tint-selection)' : 'transparent',
        borderLeft: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
        ...sortableStyle,
        ...(dragging ? { opacity: 0.6, cursor: 'grabbing', zIndex: 1, position: 'relative' } : {}),
      }}
    >
      {/* 종목명은 가격(text-sm)보다 의도적으로 작게(text-xs) — 그룹 헤더(text-sm/600) >
          종목명 크기 위계 + 가격이 1차 콘텐츠. 등락(text-xs)과는 서체(mono)·색으로 구분. */}
      <span className="flex-1 truncate text-xs text-fg">{name}</span>
      <span className="flex flex-col items-end leading-tight">
        <span className="font-mono tabular-nums text-sm text-fg">
          {price != null ? `${price.toLocaleString('ko-KR')}원` : '—'}
        </span>
        <span className="font-mono tabular-nums text-xs">
          <QuoteChange won={changeWon} pct={pct} />
        </span>
      </span>
      {trailingAction != null && (
        <span className="flex items-center justify-center" style={{ minWidth: '1.25rem' }}>
          {trailingAction}
        </span>
      )}
    </li>
  );
}
