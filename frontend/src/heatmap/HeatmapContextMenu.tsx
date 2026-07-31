import { useDismissablePopover } from '../util/useDismissablePopover';
import { useClampedFixedPosition } from '../util/useClampedFixedPosition';

export type HeatmapMenuItem = {
  /** data-testid 접미사 겸 React key. */
  key: string;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  /** danger = 파괴적 동작(그룹 삭제) — error 색 + error 틴트 호버. */
  tone?: 'danger';
};

/**
 * 히트맵 컨텍스트 메뉴 셸 — 행 메뉴(HeatmapRowMenu)와 그룹 헤더 메뉴(HeatmapGroupMenu)가
 * 공유한다. 커서 (x,y)에 fixed 로 뜨되 `useClampedFixedPosition` 이 렌더 후 자기 rect 를
 * 실측해 우/하단 오버플로를 보정하고, `useDismissablePopover` 가 바깥 클릭/Escape 를 닫는다.
 *
 * 관심종목 패널(WatchlistRowMenu)과 같은 **짧은 항목 리스트** 문법이다 — 아이콘 1열 + 라벨.
 * 목록형(그룹 전부 나열) 섹션은 두지 않는다: 그룹이 수십 개인 보드에서 메뉴가 화면을 덮어
 * 이 저장소에서 한 번 걷어낸 패턴이다(ADR-0132, 그룹 간 이동은 드래그가 담당).
 */
export function HeatmapContextMenu({ x, y, ariaLabel, testId, itemTestIdPrefix, items, onClose }: {
  x: number;
  y: number;
  ariaLabel: string;
  testId: string;
  itemTestIdPrefix: string;
  items: HeatmapMenuItem[];
  onClose: () => void;
}) {
  const { ref, left, top } = useClampedFixedPosition<HTMLDivElement>(x, y);
  useDismissablePopover(true, ref, onClose);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={ariaLabel}
      data-testid={testId}
      onContextMenu={(e) => e.preventDefault()}
      className="bg-bg-card border border-border rounded shadow-lg z-30 py-1"
      style={{ position: 'fixed', left, top, minWidth: '8rem' }}
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          data-testid={`${itemTestIdPrefix}-${item.key}`}
          onClick={() => { item.onClick(); onClose(); }}
          className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 ${
            item.tone === 'danger'
              ? 'text-error hover:bg-tint-error'
              : 'text-fg-dim hover:text-fg hover:bg-bg-input-hover'
          }`}
        >
          <span className="w-4 grid place-items-center">{item.icon}</span>
          {item.label}
        </button>
      ))}
    </div>
  );
}
