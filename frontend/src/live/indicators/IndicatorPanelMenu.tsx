import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDismissablePopover } from '../../util/useDismissablePopover';
import { useClampedFixedPosition } from '../../util/useClampedFixedPosition';

/**
 * 지표 패널 헤더의 ⋯ 오버플로 메뉴 — 지금은 「{봉} 지표 초기화」 하나뿐이다.
 *
 * ## 왜 헤더로 옮겼나
 *
 * 이 항목은 종전에 nav 하단 **상시 푸터**였다. 가장 위험하고 가장 드물게 쓰는 것이
 * 매일 쓰는 목록의 자리를 상시로 차지하고 있었다는 뜻이다. 빈도와 위험도가 둘 다
 * 반대 방향을 가리키므로 한 단계 물러난 곳이 맞다.
 *
 * ## 보호 수준은 그대로다
 *
 * 확인은 **메뉴 안 인라인 2단계**로 유지한다(파괴적 사다리 2단, DESIGN.md).
 * `ConfirmModal` 로 올리지 않는 이유는 그게 **중첩 모달**이 되어서다 — 이 패널이
 * 이미 모달이고, 모달 위 모달은 Escape 가 어느 것을 닫는지부터 모호해진다.
 *
 * ## 열림 상태를 밖에서 쥔다 (controlled)
 *
 * `open`/`onOpenChange` 를 부모가 소유하는 것이 이 컴포넌트가 `CardRestoreMenu`
 * 와 갈리는 유일한 지점이고, 이유는 **Escape 의 순서**다. `ModalShell` 의 Escape
 * 리스너는 `document` 에 있고 팝오버의 것은 `window` 에 있어 document 쪽이 먼저
 * 발화한다 — 메뉴만 닫으려 눌러도 패널이 함께 닫힌다. 부모가 열림 여부를 알아야
 * 그 Escape 를 가로채 "메뉴만 닫기" 로 돌릴 수 있다.
 */
export default function IndicatorPanelMenu({
  open,
  onOpenChange,
  resetLabel,
  confirmLabel,
  onReset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** '분봉 지표 초기화' 처럼 봉이 박힌 항목 라벨. */
  resetLabel: string;
  /** '분봉 초기화?' — 확인 행의 물음. */
  confirmLabel: string;
  onReset: () => void;
}) {
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  // 확인 단계는 메뉴가 닫히면 함께 풀린다 — 다시 열었을 때 armed 상태가 남아 있으면
  // 「초기화」 버튼이 첫 클릭에 노출된 채로 시작한다.
  const [confirming, setConfirming] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    onOpenChange(false);
    setConfirming(false);
  }, [onOpenChange]);
  useDismissablePopover(open, wrapRef, close);

  const { ref: menuPositionRef, left, top } = useClampedFixedPosition<HTMLDivElement>(
    anchorRect ? anchorRect.right - 236 : 0,
    anchorRect ? anchorRect.bottom + 4 : 0,
  );

  const toggle = () => {
    setAnchorRect(buttonRef.current?.getBoundingClientRect() ?? null);
    if (open) close();
    else onOpenChange(true);
  };

  const menu = open && anchorRect ? (
    <div
      ref={menuPositionRef}
      role="menu"
      aria-label="패널 메뉴"
      onMouseDown={(event) => event.stopPropagation()}
      className="z-[70] w-[236px] rounded-lg border border-border bg-bg-card p-1 shadow-overlay"
      style={{ position: 'fixed', left, top }}
    >
      {confirming ? (
        <div className="flex items-center justify-between gap-2 px-2 py-1.5">
          <span className="text-xs text-fg-dim">{confirmLabel}</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={close}
              className="rounded px-2 py-1 text-xs text-fg-dim hover:bg-bg-input-hover hover:text-fg"
            >
              취소
            </button>
            <button
              type="button"
              onClick={() => { onReset(); close(); }}
              className="rounded px-2 py-1 text-xs font-medium"
              style={{ background: 'var(--error)', color: 'var(--fg)' }}
            >
              초기화
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          role="menuitem"
          data-testid="indicator-panel-menu-reset"
          onClick={() => setConfirming(true)}
          className="block w-full rounded-md px-2.5 py-1.5 text-left text-sm text-fg-dim hover:bg-bg-input-hover hover:text-fg"
        >
          {resetLabel}
          <small className="block text-xs text-fg-dim">
            이 창의 이 봉 설정만 기본값으로 되돌립니다
          </small>
        </button>
      )}
    </div>
  ) : null;

  return (
    <div ref={wrapRef} className="relative">
      {/* aria-label 이 '닫기' 가 **아니어야** 한다 — 헤더의 ✕ 와 이름이 겹치면
          "닫기 버튼은 하나" 를 재는 단언이 둘을 잡는다. */}
      <button
        ref={buttonRef}
        type="button"
        aria-label="패널 메뉴"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="indicator-panel-menu"
        onClick={toggle}
        className="flex size-6 items-center justify-center rounded-md text-fg-dim transition-colors hover:bg-bg-input-hover hover:text-fg"
      >
        ⋯
      </button>
      {menu && createPortal(menu, document.body)}
    </div>
  );
}
