import { useClampedFixedPosition } from '../util/useClampedFixedPosition';
import { useDismissablePopover } from '../util/useDismissablePopover';

/**
 * 매치 행 메뉴 — 우클릭(커서 앵커)이 연다. 행 호버 ⋯ 버튼도 같은 메뉴를 열었으나
 * 사용자 요청으로 제거했다(2026-09-04) — 진입점은 우클릭 하나다.
 *
 * **항목이 하나뿐인 것이 설계다.** 「차트로 이동」·「새 탭」은 이미 클릭·⌘클릭이 하고
 * 있으므로 메뉴로 중복 노출하지 않는다(`StudyViewRowMenu` 가 「새 탭에서 열기」를 뺀
 * 것과 같은 근거).
 *
 * 위치 보정·dismiss 계약은 다른 행 메뉴와 **같은 primitive** 를 탄다
 * (`useClampedFixedPosition` + `useDismissablePopover`).
 */
const itemClass =
  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-fg hover:bg-bg-input-hover';

function Glyph({ children }: { children: React.ReactNode }) {
  return (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}
/** 한 자리 — 금지 표시 하나. */
const BlockIcon = () => <Glyph><circle cx="12" cy="12" r="9" /><path d="M5.6 5.6l12.8 12.8" /></Glyph>;
/** 종목 전부 — 겹친 금지 표시로 「여러 개」를 말한다. */
const BlockAllIcon = () => (
  <Glyph><circle cx="9" cy="15" r="6" /><path d="M4.8 19.2l8.4-8.4" /><path d="M13 4h7v7" /></Glyph>
);

export function PatternMatchRowMenu({
  x, y, label, stockName, onExcludeRange, onExcludeCode, onClose,
}: {
  x: number;
  y: number;
  /** 접근성 라벨용 — 「삼성전자 2024-03-05」 처럼 **어느 자리인지**가 들어간다. */
  label: string;
  /** 「이 종목 전부」 항목이 무엇을 뺄지 화면에 쓴다 — 두 항목의 차이가 라벨로 보여야 한다. */
  stockName: string;
  onExcludeRange: () => void;
  onExcludeCode: () => void;
  onClose: () => void;
}) {
  const { ref, left, top } = useClampedFixedPosition<HTMLDivElement>(x, y);
  useDismissablePopover(true, ref, onClose);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`${label} 매치 메뉴`}
      data-testid="pattern-match-row-menu"
      onContextMenu={(e) => e.preventDefault()}
      className="z-30 rounded border border-border bg-bg-card py-1 shadow-lg"
      style={{ position: 'fixed', left, top, minWidth: '11rem' }}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => { onExcludeRange(); onClose(); }}
        className={itemClass}
      >
        <span className="grid w-4 place-items-center" aria-hidden="true"><BlockIcon /></span>
        이 자리만 빼기
      </button>
      {/* 자리만 빼면 같은 종목이 **다른 날짜로 다시 올라온다**(상위 100 밖에 그런 자리가
          15개 대기 중, 실측). 그게 거슬릴 때 쓰는 항목이라 나란히 둔다. */}
      <button
        type="button"
        role="menuitem"
        onClick={() => { onExcludeCode(); onClose(); }}
        className={itemClass}
      >
        <span className="grid w-4 place-items-center" aria-hidden="true"><BlockAllIcon /></span>
        «{stockName}» 전부 빼기
      </button>
    </div>
  );
}
