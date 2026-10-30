import { PanelContextMenu } from '../ui/PanelContextMenu';
import { TrashIcon } from '../ui/TrashIcon';
import { PencilIcon } from '../ui/PencilIcon';

interface Props {
  x: number;            // raw 커서/버튼 viewport 좌표
  y: number;
  name: string;         // 접근성 라벨용
  onOpen: () => void;
  onMove: () => void;
  onOpenNewTab: () => void;
  onRename: () => void;
  onEditMemo: () => void;
  onDelete: () => void;
  onClose: () => void;
}

/** 메뉴 아이콘 — 유니코드 글리프 대신 SVG 통일(WatchlistDrawer MenuGlyph와 동일 근거:
 *  폰트별 렌더 불일치 회피). 14px·선 1.6의 공통 액션 규격을 따른다. */
function MenuGlyph({ children }: { children: React.ReactNode }) {
  return (
    <svg data-ui-icon="" width="0.875rem" height="0.875rem" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}
const OpenIcon = () => <MenuGlyph><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></MenuGlyph>;
const MemoIcon = () => <MenuGlyph><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h9" /></MenuGlyph>;

const itemClass =
  'w-full text-left px-3 py-1.5 text-sm text-fg hover:bg-bg-input-hover flex items-center gap-2';

/** 저장뷰 행의 우클릭·키보드 메뉴. 새 탭은 브라우저 탭이다. */
export function StudyViewRowMenu({ x, y, name, onOpen, onMove, onOpenNewTab, onRename, onEditMemo, onDelete, onClose }: Props) {
  const run = (action: () => void) => () => { action(); onClose(); };

  return (
    <PanelContextMenu point={{ x, y }} label={`${name} 저장뷰 메뉴`} showLabel={false} onClose={onClose}>
      <div data-testid="study-view-row-menu">
        <button type="button" role="menuitem" onClick={run(onOpen)} className={itemClass}>
          <span className="w-4 grid place-items-center"><OpenIcon /></span> 열기
        </button>
        <button type="button" role="menuitem" onClick={run(onOpenNewTab)} className={itemClass}>새 탭에서 열기</button>
        <button type="button" role="menuitem" onClick={run(onMove)} className={itemClass}>그룹 이동</button>
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
    </PanelContextMenu>
  );
}
