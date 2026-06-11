import { useEffect } from 'react';
import { useRightRailStore } from '../state/rightRail';

/**
 * Keyboard shortcuts for the /live page (Addendum Task 9.y / Design B7).
 *
 *   j   — focus next watchlist code (handled via callback for caller wiring)
 *   k   — focus previous watchlist code
 *   w   — toggle watchlist panel
 *   Esc — close the open panel if any (do not toggle off otherwise)
 *
 * Shortcuts are suppressed when the user is typing in an input/textarea or
 * any element with `data-prevent-shortcuts`. This avoids interfering with
 * stock code search etc.
 */
export interface UseLiveKeyboardOpts {
  onNextCode?: () => void;
  onPrevCode?: () => void;
  onNextTab?: () => void;
  onPrevTab?: () => void;
  onSelectTabIndex?: (index: number) => void;
}

export function shouldIgnoreEvent(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  if (target.closest('[data-prevent-shortcuts]')) return true;
  return false;
}

export function useLiveKeyboard(opts: UseLiveKeyboardOpts = {}): void {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (shouldIgnoreEvent(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key) {
        case 'j':
          opts.onNextCode?.();
          e.preventDefault();
          break;
        case 'k':
          opts.onPrevCode?.();
          e.preventDefault();
          break;
        case ']':
          opts.onNextTab?.();
          e.preventDefault();
          break;
        case '[':
          opts.onPrevTab?.();
          e.preventDefault();
          break;
        case 'w':
          useRightRailStore.getState().togglePanel('watchlist');
          e.preventDefault();
          break;
        case 'Escape':
          // 모달/팝오버가 열려 있으면 Escape는 그쪽 소유 — 패널까지 같이 닫지
          // 않는다. ModalShell은 document, useDismissablePopover는 window 리스너
          // 인데 이 핸들러가 먼저 등록돼 stopPropagation으로는 막을 수 없으므로
          // DOM에 열린 dialog/menu가 있는지를 단일 진실로 삼는다.
          if (document.querySelector('[role="dialog"], [role="menu"]')) break;
          if (useRightRailStore.getState().activePanel) {
            useRightRailStore.getState().setActivePanel(null);
            e.preventDefault();
          }
          break;
        default:
          if (e.key >= '1' && e.key <= '9' && opts.onSelectTabIndex) {
            opts.onSelectTabIndex(Number(e.key) - 1);
            e.preventDefault();
          }
          break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [opts.onNextCode, opts.onPrevCode, opts.onNextTab, opts.onPrevTab, opts.onSelectTabIndex]);
}
