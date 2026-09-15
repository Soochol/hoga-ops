import { useEffect } from 'react';
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
 * 행 메뉴는 높이가 제한된 관심 그룹 선택 내용을 children으로 제공한다.
 * 히트맵 그룹 간 이동은 드래그가 담당한다.
 */
export function HeatmapContextMenu({ x, y, ariaLabel, testId, itemTestIdPrefix, items, onClose, children }: {
  x: number;
  y: number;
  ariaLabel: string;
  testId: string;
  itemTestIdPrefix: string;
  items: HeatmapMenuItem[];
  children?: React.ReactNode;
  onClose: () => void;
}) {
  const { ref, left, top } = useClampedFixedPosition<HTMLDivElement>(x, y);
  useDismissablePopover(true, ref, onClose);
  useEffect(() => {
    const trigger = document.activeElement;
    const menu = ref.current;
    if (menu?.getAttribute('role') === 'dialog') menu.focus();
    else menu?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => {
      if ((document.activeElement === document.body || menu?.contains(document.activeElement))
        && trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, [ref]);

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role={children ? "dialog" : "menu"}
      aria-label={ariaLabel}
      data-testid={testId}
      onContextMenu={(e) => e.preventDefault()}
      className="bg-bg-card border border-border rounded shadow-lg z-[60] py-1 max-h-[calc(100vh-16px)] overflow-y-auto max-w-[calc(100vw-16px)]"
      style={{ position: 'fixed', left, top, minWidth: '8rem', width: children ? '18rem' : undefined }}
    >
      {children}
      {children && <div className="border-t border-border my-1" />}
      <div role={children ? "menu" : undefined} aria-label={children ? "종목 작업" : undefined}>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="menuitem"
          data-testid={`${itemTestIdPrefix}-${item.key}`}
          onClick={() => { item.onClick(); onClose(); }}
          className={`${children && item.key === 'remove' ? 'border-t border-border mt-1 ' : ''}w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 ${
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
    </div>
  );
}
