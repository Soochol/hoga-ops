import { useEffect } from 'react';
import { useRightRailStore } from '../state/rightRail';

/**
 * Keyboard shortcuts for the /live page (Addendum Task 9.y / Design B7).
 *
 *   j   — focus next watchlist code (handled via callback for caller wiring)
 *   k   — focus previous watchlist code
 *   w   — toggle watchlist panel
 *   Esc — close watchlist panel if open (do not toggle off otherwise)
 *
 * Shortcuts are suppressed when the user is typing in an input/textarea or
 * any element with `data-prevent-shortcuts`. This avoids interfering with
 * stock code search etc.
 */
export interface UseLiveKeyboardOpts {
  onNextCode?: () => void;
  onPrevCode?: () => void;
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
        case 'w':
          useRightRailStore.getState().togglePanel('watchlist');
          e.preventDefault();
          break;
        case 'Escape':
          if (useRightRailStore.getState().activePanel) {
            useRightRailStore.getState().setActivePanel(null);
            e.preventDefault();
          }
          break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [opts.onNextCode, opts.onPrevCode]);
}
