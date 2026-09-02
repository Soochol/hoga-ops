import { useClampedFixedPosition } from '../util/useClampedFixedPosition';
import { useDismissablePopover } from '../util/useDismissablePopover';

/**
 * 매치 행 메뉴 — 우클릭(커서 앵커)과 행 호버 ⋯ 버튼(버튼 앵커)이 공유한다.
 *
 * **항목이 하나뿐인 것이 설계다.** 「차트로 이동」·「새 탭」은 이미 클릭·⌘클릭이 하고
 * 있으므로 메뉴로 중복 노출하지 않는다(`StudyViewRowMenu` 가 「새 탭에서 열기」를 뺀
 * 것과 같은 근거).
 *
 * 위치 보정·dismiss 계약은 다른 행 메뉴와 **같은 primitive** 를 탄다
 * (`useClampedFixedPosition` + `useDismissablePopover`).
 */
export function PatternMatchRowMenu({
  x, y, label, onExclude, onClose,
}: {
  x: number;
  y: number;
  /** 접근성 라벨용 — 「삼성전자 2024-03-05」 처럼 **어느 자리인지**가 들어간다.
   *  종목이 아니라 그 종목의 그 기간을 빼는 기능이라 이름만으로는 모자라다. */
  label: string;
  onExclude: () => void;
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
        onClick={() => { onExclude(); onClose(); }}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-fg hover:bg-bg-input-hover"
      >
        <span className="grid w-4 place-items-center" aria-hidden="true">
          <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" /><path d="M5.6 5.6l12.8 12.8" />
          </svg>
        </span>
        이 결과에서 빼기
      </button>
    </div>
  );
}
