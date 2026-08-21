import { useEffect, useRef, useState, type ReactNode } from 'react';

// Shared center-modal chrome: full-screen backdrop, Escape + backdrop dismissal,
// and the canon card (bg-card / border-strong / 6px / shadow). The
// optional `title` renders the standard header (title + ✕ 닫기). Callers supply
// the body (and footer) as children. Concentrates the modal dismissal contract
// in one place — consumed by ConfirmModal, SettingsDrawer, IndicatorPanel, App.
//
// `side='right'` turns it into a right-anchored, full-height drawer (slides in)
// with a lighter dim so the chart stays visible on the left (ADR-0116). Default
// 'center' keeps every existing caller unchanged.
//
// ⚠ **`side='right'` 는 2026-08-21 부터 앱 소비자가 0 이다** — 설정·보조지표가 중앙
// 모달로 옮겨가면서(사용자 결정, DESIGN.md 결정 로그) 마지막 두 소비자가 사라졌다.
// 코드와 `ModalShell.test.tsx` 커버리지는 되돌릴 여지를 위해 남겨 둔다. 새로 쓰려면
// 그 결정 로그를 먼저 읽을 것 — 되돌림이지 신규 선택지가 아니다.
//
// 포커스 계약(2026-08-04): aria-modal="true" 를 선언하는 이상 실제로도 모달이어야
// 한다 — 열릴 때 카드 안 첫 포커서블(없으면 카드 자신)로 포커스, Tab/Shift+Tab 은
// 카드 안에서 순환(trap), 닫히면 열기 전 요소로 복원. 백드롭 닫힘은 click 이 아니라
// **mousedown + target 검사** — click 기준이면 카드 안에서 드래그(텍스트 선택)를
// 시작해 백드롭에서 놓을 때 click 이 공통 조상(백드롭)에서 발화해 오작동으로 닫힌다.
// mousedown 기준은 useDismissablePopover 와 같은 관례.

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export function ModalShell({ ariaLabel, title, width = 'w-[640px]', height, side = 'center', onClose, children }: {
  ariaLabel: string;
  title?: string;
  width?: string;
  /** Optional fixed-height classes (e.g. `h-[600px] max-h-[88vh]`). Omit to size
   *  to content. Required when the body has its own `overflow-auto` scroll region,
   *  which needs a bounded-height ancestor to clip against. Ignored for side='right'
   *  (drawer is always full-height). */
  height?: string;
  /** 'center' (default) = centered card; 'right' = full-height right drawer. */
  side?: 'center' | 'right';
  onClose: () => void;
  children: ReactNode;
}) {
  const isDrawer = side === 'right';
  // Slide-in on mount (drawer only). No exit animation — unmount is immediate.
  const [shown, setShown] = useState(!isDrawer);
  useEffect(() => {
    if (isDrawer) setShown(true);
  }, [isDrawer]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const cardRef = useRef<HTMLDivElement>(null);

  // 초기 포커스 + 복원 — 마운트 시 1회. 복원 대상이 이미 DOM 에서 떨어졌으면
  // (탭이 닫혔다든가) focus 호출이 조용히 무시되므로 connected 검사만 한다.
  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const card = cardRef.current;
    const first = card?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    (first ?? card)?.focus();
    return () => {
      if (prev?.isConnected) prev.focus();
    };
  }, []);

  // Tab 순환(trap). 카드 밖으로 나가려는 첫/끝 경계에서만 개입 — 중간 이동은
  // 브라우저 기본에 맡긴다(포커서블 목록을 매 keydown 재조회하므로 동적 콘텐츠 안전).
  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const card = cardRef.current;
    if (!card) return;
    const els = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    if (els.length === 0) { e.preventDefault(); return; }
    const first = els[0];
    const last = els[els.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === card)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const backdropClass = isDrawer
    ? 'fixed inset-0 bg-black/30 flex items-stretch justify-end z-[60]'
    : 'fixed inset-0 bg-black/50 flex items-center justify-center z-[60]';
  const cardClass = isDrawer
    ? `bg-bg-card border-l border-border-strong shadow-overlay ${width} h-full max-w-[95vw] flex flex-col transition-transform duration-150 ease-out ${shown ? 'translate-x-0' : 'translate-x-full'}`
    : `bg-bg-card border border-border-strong rounded-lg shadow-overlay ${width} ${height ?? ''} max-w-[90vw] flex flex-col`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={trapTab}
      className={backdropClass}
    >
      <div ref={cardRef} tabIndex={-1} className={`outline-none ${cardClass}`}>
        {title && (
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <h2 className="text-fg text-base font-medium">{title}</h2>
            <button type="button" aria-label="닫기" onClick={onClose}
              className="text-fg-dim hover:text-fg text-lg leading-none">✕</button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
