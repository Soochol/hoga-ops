import { useDismissablePopover } from '../util/useDismissablePopover';
import { useClampedFixedPosition } from '../util/useClampedFixedPosition';
import { HeartIcon } from '../ui/HeartIcon';
import { CheckIcon } from '../ui/CheckIcon';

interface Props {
  x: number;            // raw 커서 viewport 좌표
  y: number;
  name: string;         // 접근성 라벨용
  onEditGroups: () => void;   // "그룹 편집" → WatchlistGroupPicker 오픈(v3, ADR-0070)
  onRemove: () => void;       // 관심 해제(모든 폴더에서 제거)
  /** "위에 빈칸 삽입" — 이 행 자리에 메모를 넣는다(v4). 미분류 행은 넣을 폴더가
   *  없으므로 미전달 → 항목이 아예 안 뜬다. */
  onInsertMemoAbove?: () => void;
  onClose: () => void;
}

type MenuItem = { key: string; label: string; icon: React.ReactNode; onClick: () => void };

/**
 * 관심종목 행 우클릭 컨텍스트 메뉴 (워치리스트 전용, v3). 커서 (x,y)에 fixed 로 뜨되
 * `useClampedFixedPosition` 이 렌더 후 자기 rect 를 실측해 우/하단 오버플로를 보정한다.
 * v2의 "그룹으로 이동"(단일 folder_id 교체)은 다중 소속에서 의미가 깨져, "그룹 편집"
 * (WatchlistGroupPicker)으로 통일했다 — 하트 팝업과 동일 primitive(ADR-0070 P5).
 */
export function WatchlistRowMenu({ x, y, name, onEditGroups, onRemove, onInsertMemoAbove, onClose }: Props) {
  const { ref, left, top } = useClampedFixedPosition<HTMLDivElement>(x, y);
  useDismissablePopover(true, ref, onClose);

  const items: MenuItem[] = [
    {
      key: 'edit-groups',
      label: '그룹 편집',
      icon: <CheckIcon filled size={16} />,
      onClick: () => { onEditGroups(); onClose(); },
    },
    ...(onInsertMemoAbove ? [{
      key: 'insert-memo',
      label: '위에 빈칸 삽입',
      // 장식 글리프라 --fg-dimmer 가 아니라 currentColor 를 따른다(메뉴 항목 색).
      icon: (
        <svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M4 8h16" /><path d="M4 16h16" strokeDasharray="3 3" />
        </svg>
      ),
      onClick: () => { onInsertMemoAbove(); onClose(); },
    }] : []),
    {
      key: 'remove',
      label: '관심 해제',
      icon: <HeartIcon filled className="w-[1em] h-[1em]" />,
      onClick: () => { onRemove(); onClose(); },
    },
  ];

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`${name} 컨텍스트 메뉴`}
      data-testid="watchlist-row-menu"
      onContextMenu={(e) => e.preventDefault()}
      className="bg-bg-card border border-border rounded shadow-lg z-30 py-1"
      style={{ position: 'fixed', left, top, minWidth: '8rem' }}
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          data-testid={`watchlist-menu-${item.key}`}
          onClick={item.onClick}
          className="w-full text-left px-3 py-1.5 text-sm text-fg-dim hover:text-fg hover:bg-bg-input-hover flex items-center gap-2"
        >
          <span className="w-4 grid place-items-center">{item.icon}</span>
          {item.label}
        </button>
      ))}
    </div>
  );
}
