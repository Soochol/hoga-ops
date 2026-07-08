import { useDismissablePopover } from '../util/useDismissablePopover';
import { useClampedFixedPosition } from '../util/useClampedFixedPosition';
import { TrashIcon } from '../ui/TrashIcon';

interface Props {
  x: number;            // raw 커서/버튼 viewport 좌표
  y: number;
  name: string;         // 접근성 라벨용
  onOpen: () => void;
  onOpenNewTab: () => void;
  onRename: () => void;
  onEditMemo: () => void;
  onDelete: () => void;
  onClose: () => void;
}

/** 메뉴 아이콘 — 유니코드 글리프 대신 SVG 통일(WatchlistDrawer MenuGlyph와 동일 근거:
 *  폰트별 렌더 불일치 회피). 1em 스케일이라 텍스트 크기를 따른다. */
function MenuGlyph({ children }: { children: React.ReactNode }) {
  return (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}
const OpenIcon = () => <MenuGlyph><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></MenuGlyph>;
const NewTabIcon = () => (
  <MenuGlyph>
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <path d="M15 3h6v6" />
    <path d="M10 14 21 3" />
  </MenuGlyph>
);
const PencilIcon = () => <MenuGlyph><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></MenuGlyph>;
const MemoIcon = () => <MenuGlyph><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h9" /></MenuGlyph>;

const itemClass =
  'w-full text-left px-3 py-1.5 text-sm text-fg hover:bg-bg-input-hover flex items-center gap-2';

/**
 * 저장뷰 행 메뉴 — 우클릭(커서 앵커)과 행 호버 ⋯ 버튼(버튼 앵커)이 공유한다.
 * 그간 숨겨진 제스처로만 닿던 액션(새 탭=Ctrl+클릭, 이름 변경=더블클릭, 삭제=우클릭)을
 * 한 메뉴에 모아 발견 가능하게 한다. 위치 보정·dismiss 계약은 WatchlistRowMenu와
 * 동일 primitive(useClampedFixedPosition + useDismissablePopover).
 */
export function StudyViewRowMenu({ x, y, name, onOpen, onOpenNewTab, onRename, onEditMemo, onDelete, onClose }: Props) {
  const { ref, left, top } = useClampedFixedPosition<HTMLDivElement>(x, y);
  useDismissablePopover(true, ref, onClose);

  const run = (action: () => void) => () => { action(); onClose(); };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`${name} 저장뷰 메뉴`}
      data-testid="study-view-row-menu"
      onContextMenu={(e) => e.preventDefault()}
      className="bg-bg-card border border-border rounded shadow-lg z-30 py-1"
      style={{ position: 'fixed', left, top, minWidth: '9rem' }}
    >
      <button type="button" role="menuitem" onClick={run(onOpen)} className={itemClass}>
        <span className="w-4 grid place-items-center"><OpenIcon /></span> 열기
      </button>
      <button type="button" role="menuitem" onClick={run(onOpenNewTab)} className={itemClass}>
        <span className="w-4 grid place-items-center"><NewTabIcon /></span> 새 탭에서 열기
      </button>
      <div role="separator" className="my-1 border-t border-border" />
      <button type="button" role="menuitem" onClick={run(onRename)} className={itemClass}>
        <span className="w-4 grid place-items-center"><PencilIcon /></span> 이름 변경
      </button>
      <button type="button" role="menuitem" onClick={run(onEditMemo)} className={itemClass}>
        <span className="w-4 grid place-items-center"><MemoIcon /></span> 메모 편집
      </button>
      {/* 파괴적 액션 — 디바이더 + --error 로 인접 항목과 시각 거리를 벌리는 모터 가드
          (WatchlistDrawer 그룹 삭제와 동일 관용구). */}
      <div role="separator" className="my-1 border-t border-border" />
      <button
        type="button"
        role="menuitem"
        onClick={run(onDelete)}
        className="w-full text-left px-3 py-1.5 text-sm text-error hover:bg-tint-error flex items-center gap-2"
      >
        <span className="w-4 grid place-items-center"><TrashIcon className="w-[1em] h-[1em]" /></span> 삭제
      </button>
    </div>
  );
}
