import { useDismissablePopover } from '../util/useDismissablePopover';
import { useClampedFixedPosition } from '../util/useClampedFixedPosition';
import { HeartIcon } from '../ui/HeartIcon';

interface Props {
  x: number;            // raw 커서 viewport 좌표
  y: number;
  name: string;         // 접근성 라벨용
  onRemove: () => void;
  onClose: () => void;
  /** '그룹으로 이동' 섹션 — folders 미전달(빈 배열)이면 섹션 자체가 빠진다. */
  folders?: { id: string; name: string }[];
  currentFolderId?: string | null;
  onMove?: (folderId: string | null) => void;
}

type MenuItem = { key: string; label: string; icon: React.ReactNode; onClick: () => void };

/**
 * 관심종목 행 우클릭 컨텍스트 메뉴 (워치리스트 전용). 커서 (x,y)에 fixed 로 뜨되,
 * `useClampedFixedPosition` 이 렌더 후 자기 rect 를 실측해 우/하단 오버플로를
 * 보정한다(매직넘버 없음). 항목은 배열을 순회 — 추후 '메모' 가 두 번째 항목으로
 * 합류한다(그때 onMemo prop 추가). 아래에 '그룹으로 이동' 섹션이 현재 그룹을 제외한
 * 대상(+ 미분류)을 나열한다.
 */
export function WatchlistRowMenu({
  x, y, name, onRemove, onClose, folders = [], currentFolderId = null, onMove,
}: Props) {
  const { ref, left, top } = useClampedFixedPosition<HTMLDivElement>(x, y);
  useDismissablePopover(true, ref, onClose);

  const items: MenuItem[] = [
    {
      key: 'remove',
      label: '관심 해제',
      icon: <HeartIcon filled className="w-[1em] h-[1em]" />,
      onClick: () => { onRemove(); onClose(); },
    },
  ];

  // 이동 대상: 현재 그룹 제외 + (그룹 소속이면) 미분류. id=null 이 미분류.
  const moveTargets: { id: string | null; name: string }[] = [
    ...folders.filter((f) => f.id !== currentFolderId),
    ...(currentFolderId !== null ? [{ id: null, name: '미분류' }] : []),
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
      {onMove && moveTargets.length > 0 && (
        <>
          <div className="mt-1 border-t border-border px-3 pt-2 pb-1 text-xs text-fg-dimmer">그룹으로 이동</div>
          {moveTargets.map((t) => (
            <button
              key={t.id ?? '__uncat__'}
              type="button"
              role="menuitem"
              data-testid={`watchlist-menu-move-${t.id ?? 'uncat'}`}
              onClick={() => { onMove(t.id); onClose(); }}
              className="w-full text-left px-3 py-1.5 text-sm text-fg-dim hover:text-fg hover:bg-bg-input-hover flex items-center gap-2"
            >
              <span className="w-4 grid place-items-center">⇄</span>
              <span className="truncate">{t.name}</span>
            </button>
          ))}
        </>
      )}
    </div>
  );
}
