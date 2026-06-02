import { useLayoutEffect, useRef, useState } from 'react';
import { useDismissablePopover } from '../util/useDismissablePopover';
import { HeartIcon } from '../ui/HeartIcon';

interface Props {
  x: number;            // raw 커서 viewport 좌표
  y: number;
  name: string;         // 접근성 라벨용
  onRemove: () => void;
  onClose: () => void;
}

type MenuItem = { key: string; label: string; icon: React.ReactNode; onClick: () => void };

/**
 * 관심종목 행 우클릭 컨텍스트 메뉴 (워치리스트 전용). 커서 (x,y)에 fixed 로 뜨되,
 * 렌더 후 자기 rect 를 실측해 우/하단 오버플로를 보정한다(매직넘버 없음). 항목은
 * 배열을 순회 — 추후 '메모' 가 두 번째 항목으로 합류한다(그때 onMemo prop 추가).
 */
export function WatchlistRowMenu({ x, y, name, onRemove, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useDismissablePopover(true, menuRef, onClose);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const left = x + width  > window.innerWidth  ? Math.max(0, window.innerWidth  - width)  : x;
    const top  = y + height > window.innerHeight ? Math.max(0, window.innerHeight - height) : y;
    setPos({ left, top });
  }, [x, y]);

  const items: MenuItem[] = [
    {
      key: 'remove',
      label: '관심 해제',
      icon: <HeartIcon filled className="w-[1em] h-[1em]" />,
      onClick: () => { onRemove(); onClose(); },
    },
  ];

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={`${name} 컨텍스트 메뉴`}
      data-testid="watchlist-row-menu"
      onContextMenu={(e) => e.preventDefault()}
      className="bg-bg-card border border-border rounded shadow-lg z-30 py-1"
      style={{ position: 'fixed', left: pos.left, top: pos.top, minWidth: '8rem' }}
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
