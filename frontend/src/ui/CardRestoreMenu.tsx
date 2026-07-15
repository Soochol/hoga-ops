import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDismissablePopover } from '../util/useDismissablePopover';
import { useClampedFixedPosition } from '../util/useClampedFixedPosition';

export type RestorableCard = { key: string; label: string };

/**
 * 숨긴 상세 카드를 다시 표시하는 "+ 카드 추가" 메뉴 (ADR-0114).
 * /live·/study 상세 패널이 공유한다. hidden 이 비면 아무것도 렌더하지 않는다.
 */
export function CardRestoreMenu({
  hidden,
  onRestore,
  testId,
}: {
  hidden: readonly RestorableCard[];
  onRestore: (key: string) => void;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismissablePopover(open, wrapRef, close);
  const { ref: menuPositionRef, left, top } = useClampedFixedPosition<HTMLDivElement>(
    anchorRect?.left ?? 0,
    anchorRect ? anchorRect.bottom + 4 : 0,
  );

  if (hidden.length === 0) return null;

  const toggle = () => {
    setAnchorRect(buttonRef.current?.getBoundingClientRect() ?? null);
    setOpen((prev) => !prev);
  };

  const pick = (key: string) => {
    setOpen(false);
    onRestore(key);
  };

  const menu = open && anchorRect ? (
    <div
      ref={menuPositionRef}
      role="menu"
      aria-label="숨긴 카드 목록"
      onMouseDown={(event) => event.stopPropagation()}
      className="min-w-32 rounded border border-border bg-bg-card py-1 shadow-overlay z-50"
      style={{ position: 'fixed', left, top }}
    >
      {hidden.map((card) => (
        <button
          key={card.key}
          type="button"
          role="menuitem"
          data-testid={testId ? `${testId}-item-${card.key}` : undefined}
          onClick={() => pick(card.key)}
          className="w-full px-3 py-1.5 text-left text-xs text-fg-dim hover:bg-bg-input-hover hover:text-fg"
        >
          {card.label}
        </button>
      ))}
    </div>
  ) : null;

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={buttonRef}
        type="button"
        data-testid={testId}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
        className="rounded px-2 py-0.5 text-[11px] font-medium text-fg-dimmer hover:bg-bg-input-hover hover:text-fg"
      >
        + 카드 추가
      </button>
      {menu && createPortal(menu, document.body)}
    </div>
  );
}
