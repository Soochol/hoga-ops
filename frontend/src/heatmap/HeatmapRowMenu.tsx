import { useDismissablePopover } from '../util/useDismissablePopover';
import { useClampedFixedPosition } from '../util/useClampedFixedPosition';
import { TrashIcon } from '../ui/TrashIcon';

interface Props {
  x: number;            // raw 커서 viewport 좌표
  y: number;
  name: string;         // 접근성 라벨용
  onRemove: () => void;
  onClose: () => void;
  /** '그룹으로 이동' 섹션 — folders 미전달(빈 배열)이면 섹션 자체가 빠진다. */
  folders?: { id: string; name: string }[];
  currentFolderId?: string;
  onMove?: (folderId: string) => void;
  /** '지난 N일 수집' — 미전달이면 항목이 빠진다. */
  onCollect?: () => void;
}

/**
 * 히트맵 행 우클릭 컨텍스트 메뉴 (히트맵 전용, ADR-0068 G3). WatchlistRowMenu 와 같은
 * 위치/닫힘 유틸(useClampedFixedPosition·useDismissablePopover)을 공유하되, 라벨은
 * '히트맵에서 제거'(관심 해제 아님)로 독립 스토어임을 분명히 한다. 삭제는 히트맵 보드의
 * MVP 편집 수단 — 분리 후 watchlist 드로어가 더 이상 히트맵을 편집하지 않기 때문.
 * 아래 '그룹으로 이동' 섹션이 현재 그룹을 제외한 실폴더를 나열한다(v3: 미분류 없음).
 */
export function HeatmapRowMenu({
  x, y, name, onRemove, onClose, folders = [], currentFolderId, onMove, onCollect,
}: Props) {
  const { ref, left, top } = useClampedFixedPosition<HTMLDivElement>(x, y);
  useDismissablePopover(true, ref, onClose);

  // 이동 대상: 현재 그룹 제외.
  const moveTargets = folders.filter((f) => f.id !== currentFolderId);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`${name} 컨텍스트 메뉴`}
      data-testid="heatmap-row-menu"
      onContextMenu={(e) => e.preventDefault()}
      className="bg-bg-card border border-border rounded shadow-lg z-30 py-1"
      style={{ position: 'fixed', left, top, minWidth: '8rem' }}
    >
      <button
        type="button"
        role="menuitem"
        data-testid="heatmap-menu-remove"
        onClick={() => { onRemove(); onClose(); }}
        className="w-full text-left px-3 py-1.5 text-sm text-fg-dim hover:text-fg hover:bg-bg-input-hover flex items-center gap-2"
      >
        <span className="w-4 grid place-items-center"><TrashIcon className="w-[1em] h-[1em]" /></span>
        히트맵에서 제거
      </button>
      {onCollect && (
        <button
          type="button"
          role="menuitem"
          data-testid="heatmap-menu-collect"
          onClick={() => { onCollect(); onClose(); }}
          className="w-full text-left px-3 py-1.5 text-sm text-fg-dim hover:text-fg hover:bg-bg-input-hover flex items-center gap-2"
        >
          <span className="w-4 grid place-items-center">⬇</span>
          지난 N일 수집
        </button>
      )}
      {onMove && moveTargets.length > 0 && (
        <>
          <div className="mt-1 border-t border-border px-3 pt-2 pb-1 text-xs text-fg-dimmer">그룹으로 이동</div>
          {moveTargets.map((t) => (
            <button
              key={t.id}
              type="button"
              role="menuitem"
              data-testid={`heatmap-menu-move-${t.id}`}
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
