import { useEffect, useRef, useState } from 'react';
import type { DraggableSyntheticListeners } from '@dnd-kit/core';
import { dropIndicatorClass, sortableDraggingStyle, type DropIndicator } from '../ui/sortableDragVisuals';
import { TrashIcon } from '../ui/TrashIcon';

/**
 * 관심종목 패널의 메모("빈칸") 행 — 종목명 자리에 메모 텍스트가 보이고 가격 컬럼은 없다.
 *
 * **QuoteRow 를 재사용하지 않는 이유**: 그 컴포넌트는 관심·순위·스크리너·히트맵 네
 * 리스트가 공유한다(파일 주석이 직접 경고). 메모 전용 분기를 넣으면 네 리스트가 같이
 * 흔들린다. 대신 높이(min-h-list-row)·들여쓰기(pl-10)·하단 구분선을 같은 토큰으로
 * 맞춰 시각적으로만 한 리스트로 읽히게 한다.
 *
 * **차트로 이동하지 않는다** — `role="button"` 이 아니고 `data-quote-row` 도 붙이지
 * 않는다. QuoteRow 의 ↑↓ 네비게이션이 `[data-quote-row]` 로 행을 모으므로, 그
 * 속성이 없으면 키보드 이동이 이 행을 **자동으로 건너뛴다**(별도 분기 불필요).
 *
 * 색은 `--fg-dim` 이다. DESIGN.md(2026-08-04): 소형 텍스트에 `--fg-dimmer` 를 쓰지
 * 않는다 — 그건 비활성 요소·장식 글리프 전용이다. 종목명(`--fg`)보다 한 단계 물러나
 * 위계는 색으로 표현하되 대비는 지킨다.
 */
export interface MemoRowProps {
  text: string;
  /** 저장 트리거 — 값이 바뀐 경우에만 호출된다. */
  onSave: (text: string) => void;
  onDelete: () => void;
  maxLength: number;
  /** 갓 만든 빈칸이면 즉시 편집 모드로 연다(추가 → 바로 입력). */
  autoEdit?: boolean;
  /** autoEdit 를 소비했음을 부모에 알린다 — 부모가 플래그를 지워야 폴링 리페치마다
   *  이 행이 다시 편집 모드로 열리지 않는다. 참조가 안정적이어야 한다(useCallback). */
  onAutoEditConsumed?: () => void;
  testId: string;
  // --- drag (패널 dnd; 미전달 시 비-드래그) ---
  // dnd-kit 의 `attributes`(role=button/tabindex)는 **일부러 받지 않는다** — 행 안에
  // 삭제 버튼이 있어 중첩 인터랙티브가 되고(GroupHeader 가 같은 이유로 spread 하지
  // 않는다), role=button 은 "차트로 이동하는 행" 이라는 QuoteRow 의 의미와도 겹친다.
  // 드래그는 포인터 전용이다(KeyboardSensor 미도입 — 편집 모달 ⠿ 핸들과 동일 계약).
  sortableRef?: (node: HTMLElement | null) => void;
  sortableStyle?: Pick<React.CSSProperties, 'transform' | 'transition'>;
  dragListeners?: DraggableSyntheticListeners;
  dragActivatorRef?: (node: HTMLElement | null) => void;
  dragging?: boolean;
  dropIndicator?: DropIndicator;
}

export function MemoRow({
  text, onSave, onDelete, maxLength, autoEdit, onAutoEditConsumed, testId,
  sortableRef, sortableStyle, dragListeners, dragActivatorRef,
  dragging, dropIndicator,
}: MemoRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const inputRef = useRef<HTMLInputElement>(null);
  // autoEdit 는 **prop 변화에 반응**해야 한다 — useState 초기값으로만 받으면 마운트
  // 순서에 걸린다. 추가 직후 invalidate 로 인한 refetch(→ 이 행 마운트)와 부모의
  // setJustAddedMemoId 가 경쟁하는데, refetch 가 먼저 오면 autoEdit=false 로
  // 마운트되고 뒤늦은 setState 는 초기값을 못 바꾼다(실제 브라우저에서만 갈리는
  // 순서라 jsdom 단위 테스트는 통과했다 — e2e 가 잡았다).
  useEffect(() => {
    if (!autoEdit) return;
    setEditing(true);
    onAutoEditConsumed?.();
  }, [autoEdit, onAutoEditConsumed]);
  // 편집 중 서버 값이 바뀌어도 입력 중인 draft 를 덮지 않는다(폴링 60s 와 충돌 방지).
  useEffect(() => { if (!editing) setDraft(text); }, [text, editing]);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  const commit = () => {
    setEditing(false);
    if (draft !== text) onSave(draft);
  };
  const cancel = () => { setDraft(text); setEditing(false); };

  const setRowRef = (node: HTMLElement | null) => {
    sortableRef?.(node);
    if (dragListeners) dragActivatorRef?.(node);
  };

  const rowClass =
    `group pl-10 pr-md py-0.5 min-h-list-row flex items-center gap-2 border-b border-border ` +
    `hover:bg-bg-input-hover ${dropIndicatorClass(dropIndicator)}`;
  const rowStyle: React.CSSProperties = {
    ...sortableStyle,
    ...(dragging ? sortableDraggingStyle(18) : {}),
    ...(dropIndicator ? { position: 'relative' } : {}),
  };

  if (editing) {
    return (
      <li data-testid={testId} className={rowClass} style={rowStyle}>
        <input
          ref={inputRef}
          value={draft}
          maxLength={maxLength}
          aria-label="메모 입력"
          data-testid={`${testId}-input`}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          // 드로어 스크롤 컨테이너가 [data-quote-nav] 이고 종목 행들이 ↑↓·Delete·
          // Enter 를 잡는다. 입력 중 그 키가 위로 새면 행 삭제나 차트 전환이
          // 오발동하므로 여기서 경계를 세운다 — Escape 도 팝오버 dismiss 로 새면
          // 취소와 동시에 메뉴가 닫히는 이중 동작이 된다.
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
          }}
          className="flex-1 min-w-0 bg-transparent text-xs text-fg leading-tight outline-none border-b border-accent"
        />
      </li>
    );
  }

  return (
    <li
      ref={setRowRef}
      {...dragListeners}
      data-testid={testId}
      // data-quote-row 를 붙이지 않는다 → QuoteRow 의 ↑↓ 네비게이션이 건너뛴다.
      className={`${rowClass} cursor-text touch-none`}
      style={rowStyle}
      onClick={() => setEditing(true)}
    >
      {/* 빈 줄(text='')이면 아무것도 안 보이고 높이만 차지한다 — 그게 "빈칸"이다.
          텍스트가 있으면 종목명과 같은 x 에서 시작하되 --fg-dim 으로 물러난다. */}
      <span className="flex-1 min-w-0 truncate text-xs text-fg-dim leading-tight">
        {text}
      </span>
      <span className="flex items-center justify-center" style={{ minWidth: '1.25rem' }}>
        <button
          type="button"
          aria-label="빈칸 삭제"
          data-testid={`${testId}-delete`}
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="grid place-items-center px-1 leading-none text-fg-dim hover:text-error opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto"
        >
          <TrashIcon className="w-[1em] h-[1em]" />
        </button>
      </span>
    </li>
  );
}
