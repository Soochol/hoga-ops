import type { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core';
import { priceDirClass } from '../ui/priceDir';
import {
  dropIndicatorClass, sortableDraggingStyle, sortablePlaceholderStyle,
  type DropIndicator,
} from '../ui/sortableDragVisuals';

/** 관심종목·스크리너 드로어 공용 행: 종목명(좌) │ 현재가(+등락률)(우) │ (선택) 트레일링 액션.
 *  ScreenerResultRow 의 시각/키보드 계약을 그대로 가져오고 quote 셀을 우측에 둔다.
 *  밀도는 스크리너 결과표(DataTableRow)·HeatmapRow 와 정합 — 공용 min-h-list-row 토큰으로
 *  행 높이(≈28px @ 기본 밀도)를 맞추고, py-0.5 패딩 + 행 하단 border-b 구분선을 얹는다.
 *  우측 레일 세 드로어(관심·순위·스크리너)가 이 행을 공유하고, 스크리너 결과표·히트맵 행도
 *  같은 토큰(design-tokens list-row-min-h)에서 높이를 얻으므로 네 리스트가 한 값으로 통일된다.
 *  trailingAction: 패널이 주입하는 행 우측 affordance(하트/휴지통). 자체적으로
 *  stopPropagation/aria 를 책임진다. <li> 는 group 이라 액션이 group-hover/
 *  group-focus-within 로 등장 처리를 할 수 있다. */
export interface QuoteRowProps {
  name: string;
  price: number | null;
  pct: number | null;
  changeWon: number | null;
  /** 동시호가 예상체결가/등락률(LiveQuote.expected_*). 값이 있으면 가격·등락% 셀을
   *  예상값으로 대체하고 종목명 앞에 '*' 마커를 붙인다. 창 밖·체결 후엔 키가 사라져
   *  자동으로 확정치로 복귀(백엔드 게이트 SSOT). 미전달 시 기존 동작 그대로. */
  expectedPrice?: number | null;
  expectedPct?: number | null;
  active: boolean;
  ariaLabel: string;
  testId: string;
  // 이벤트를 그대로 넘긴다 — 호출부가 ctrl/⌘ 를 보고 새 탭으로 분기할 수 있어야
  // 한다(useJumpToLive). 선택적이라 인자 없이 부르는 기존 호출부도 그대로 유효하고,
  // KeyboardEvent 도 받으므로 ctrl+Enter 가 같은 경로를 탄다.
  onClick: (e?: React.MouseEvent<HTMLLIElement> | React.KeyboardEvent<HTMLLIElement>) => void;
  // 행 좌측 선행 슬롯(순위 패널의 순위번호). 미전달 시 기존 레이아웃 그대로.
  leading?: React.ReactNode;
  trailingAction?: React.ReactNode;
  // --- drag (선택 패널용; 미전달 시 비-드래그 동작) ---
  sortableRef?: (node: HTMLElement | null) => void;
  sortableStyle?: Pick<React.CSSProperties, 'transform' | 'transition'>;
  dragListeners?: DraggableSyntheticListeners;
  dragAttributes?: DraggableAttributes;
  dragActivatorRef?: (node: HTMLElement | null) => void;
  dragging?: boolean;
  /** `dragging` 일 때 원본 행을 어떻게 그릴지. 기본 `'lifted'` = 틴트+그림자로 들어올린
   *  모습(관심종목 외 세 리스트의 현행 동작). `'placeholder'` 는 `DragOverlay` 고스트를
   *  띄우는 리스트용 — 커서에 이미 클론이 들려 있으므로 원본은 빈 자리로 비운다. */
  draggingAppearance?: 'lifted' | 'placeholder';
  dropIndicator?: DropIndicator;
  // --- 관심종목 패널 전용 우클릭/Delete (미전달 시 무동작) ---
  onContextMenu?: (e: React.MouseEvent<HTMLLIElement>) => void;
  onDelete?: () => void;
  // --- 관심종목 패널 전용 들여쓰기: 그룹 헤더의 chevron-left 구조에서 종목명이
  // 그룹명 첫 글자(≈46px)보다 왼쪽에서 시작해 위계가 역전되는 것을 교정.
  // pl-10(50px) > 라벨 시작. 그룹 없는 스크리너는 미전달(평면 목록, 폭 절약). ---
  indented?: boolean;
  // 스크리너 모니터링 전용: 재조회로 새로 편입된 행이면 한 번 accent tint 플래시.
  flash?: boolean;
  // 검색 매칭 하이라이트(히트맵 드로어 전용). active 와 같은 배경 틴트를 쓴다 —
  // 검색 중 그룹 전체를 보여주되 매칭 행만 강조. optional 이라 타 리스트 무영향.
  matched?: boolean;
}

function formatPct(pct: number | null): string {
  if (pct === null) return '—';
  return `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

export function QuoteRow({
  name, price, pct, changeWon: _changeWon, expectedPrice, expectedPct,
  active, ariaLabel, testId, onClick, leading, trailingAction,
  sortableRef, sortableStyle, dragListeners, dragAttributes, dragActivatorRef, dragging,
  draggingAppearance = 'lifted', dropIndicator,
  onContextMenu, onDelete, indented, flash, matched,
}: QuoteRowProps) {
  void _changeWon;
  // 예상 표시 모드 — 셀 대체 규칙은 HeatmapRow 와 같고(가격·등락% 를 예상값으로),
  // 마커만 다르다: 이 행은 종목명 앞 '*', 히트맵 행은 캔들 옆 '예상'. 이 행엔 캔들
  // 글리프가 없어 마커를 걸 중립 슬롯이 없고, 가격 셀에 두면 고정폭 4.75rem 을
  // 마커와 나눠 써야 한다(사용자 요청 2026-08-14).
  const showExpected = expectedPrice != null;
  const shownPrice = showExpected ? expectedPrice : price;
  const shownPct = showExpected ? (expectedPct ?? null) : pct;
  // 마감 동시호가(15:20~15:30)엔 확정가가 이미 있는데 예상가가 그 위를 덮는다.
  // 히트맵은 캔들 글리프가 정규장 종가를 남기지만 이 행엔 캔들이 없어(폭 4.75rem)
  // 두 숫자를 나란히 둘 수 없다 — 확정가를 title 로 보존해 호버로 되찾게 한다.
  // 개장 동시호가엔 확정 등락률이 숨겨진 상태(price 만 있음)라 이 힌트가 특히 값싸다.
  const priceTitle = showExpected && price != null
    ? `예상 ${expectedPrice.toLocaleString('ko-KR')} · 직전 체결 ${price.toLocaleString('ko-KR')}`
    : undefined;
  const setRowRef = (node: HTMLElement | null) => {
    sortableRef?.(node);
    if (dragListeners) dragActivatorRef?.(node);
  };
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
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e); }
    // 화살표 위/아래: 인접 행으로 이동하며 즉시 선택(차트 전환). 스코프는 가장 가까운
    // [data-quote-nav](드로어 스크롤 컨테이너) — 관심종목은 폴더별로 <ul>이 여러 개라
    // 형제 이동만으론 그룹 경계를 못 넘기 때문. 없으면 부모(<ul>)로 폴백.
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); // 컨테이너 스크롤 대신 행 이동
      const li = e.currentTarget;
      const scope = li.closest<HTMLElement>('[data-quote-nav]') ?? li.parentElement;
      if (!scope) return;
      const rows = Array.from(scope.querySelectorAll<HTMLElement>('[data-quote-row]'));
      const next = rows.indexOf(li) + (e.key === 'ArrowDown' ? 1 : -1);
      const target = rows[next];
      if (!target) return; // 첫/마지막 행 경계에서 멈춤(순환 없음)
      target.focus();
      target.click(); // 행의 onClick(useJumpToLive) 재사용 → activeCode 전환
    }
  };
  return (
    <li
      ref={setRowRef}
      {...dragAttributes}
      {...dragListeners}
      data-testid={testId}
      data-quote-row=""
      data-matched={matched ? '' : undefined}
      role="button"
      tabIndex={0}
      aria-current={active ? 'true' : undefined}
      aria-label={ariaLabel}
      aria-keyshortcuts={onDelete ? 'Delete' : undefined}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onContextMenu={onContextMenu}
      className={`group cursor-pointer touch-none ${leading != null ? 'pl-md' : indented ? 'pl-10' : 'pl-md'} pr-md py-0.5 min-h-list-row flex items-center gap-2 border-b border-border outline-none focus-visible:outline-none hover:bg-bg-input-hover focus-visible:bg-bg-input-hover ${
        flash ? 'screener-row-flash' : ''
      } ${dropIndicatorClass(dropIndicator)}`}
      style={{
        // 선택 표식은 배경 틴트(--tint-selection)만 — 인벤토리(ListRow) 기준으로 통일.
        // 좌측 accent 바(borderLeft: 2px solid var(--accent))를 다시 넣지 말 것.
        // 관심·히트맵·스크리너·순위가 이 행을 공유하므로 여기 한 곳이 네 리스트를 결정한다(2026-07-23).
        background: active || matched ? 'var(--tint-selection)' : 'transparent',
        ...sortableStyle,
        ...(dragging
          ? (draggingAppearance === 'placeholder' ? sortablePlaceholderStyle() : sortableDraggingStyle(18))
          : {}),
        ...(dropIndicator ? { position: 'relative' } : {}),
      }}
    >
      {leading}
      {/* 종목명은 가격(text-sm)보다 의도적으로 작게(text-xs) — 그룹 헤더(text-sm/600) >
          종목명 크기 위계 + 가격이 1차 콘텐츠. 등락(text-xs)과는 서체(mono)·색으로 구분.
          truncate 는 flex 아이템 자신에 걸어야 클립된다(내부 inline span 은 overflow 를
          무시해 긴 종목명이 가격 컬럼을 침범했다). 가격/% 는 flex-none 고정폭이라
          종목명이 대신 잘리고(전체 이름은 행 aria-label), 행마다 우측 끝자리가 정렬된다. */}
      <span className="flex-1 min-w-0 truncate text-xs text-fg leading-tight">
        {/* 동시호가 예상 마커. truncate 는 위 부모(flex 아이템)에 걸려 있으므로 이
            inline span 은 자기 폭을 갖지 않고, 긴 종목명은 뒤쪽이 잘리며 마커는 항상
            남는다. 크기는 종목명 상속(text-xs) — 별표 글리프 자체가 이미 작아
            text-2xs 로 더 줄이면 밀도 다이얼 하단에서 사라진다. 색은 3차 텍스트
            --fg-dim(DESIGN.md 2026-08-04: 소형 텍스트에 --fg-dimmer 금지). */}
        {showExpected && (
          <span className="text-fg-dim" data-testid={`${testId}-expected-marker`}>*</span>
        )}
        {name}
      </span>
      {/* 가격은 --fg 중립, 등락%만 방향색 — 패널이 온통 적/청이던 것을 진정시켜 변동 큰
          종목만 눈에 띄게(조용한 터미널). 원 접미사 제거(가격 컬럼 문맥상 자명). 가격/%
          고정폭 2컬럼 우측정렬로 행마다 끝자리가 어긋나던 정렬을 맞춘다. */}
      <span title={priceTitle} className="flex-none w-[4.75rem] text-right font-data tabular-nums text-sm text-fg leading-tight">
        {shownPrice != null ? shownPrice.toLocaleString('ko-KR') : '—'}
      </span>
      <span className={`flex-none w-[3.5rem] text-right font-data tabular-nums text-xs leading-tight ${shownPct === null ? 'text-fg-dim' : priceDirClass(shownPct)}`}>
        {shownPct != null ? formatPct(shownPct) : ''}
      </span>
      {trailingAction != null && (
        <span className="flex items-center justify-center" style={{ minWidth: '1.25rem' }}>
          {trailingAction}
        </span>
      )}
    </li>
  );
}
