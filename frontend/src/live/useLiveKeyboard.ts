import { useEffect } from 'react';
import { useRightRailStore } from '../state/rightRail';
import { shouldIgnoreEvent } from '../util/keyboard';

export type LiveTimeframeShortcutSlot = 'minute' | 'D' | 'W' | 'M';

const TIMEFRAME_SHORTCUT_KEYS: Record<string, LiveTimeframeShortcutSlot> = {
  Digit1: 'minute',
  Digit2: 'D',
  Digit3: 'W',
  Digit4: 'M',
};

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
  onSelectTimeframeShortcut?: (slot: LiveTimeframeShortcutSlot) => void;
}

export function useLiveKeyboard(opts: UseLiveKeyboardOpts = {}): void {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (shouldIgnoreEvent(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.shiftKey) {
        const slot = TIMEFRAME_SHORTCUT_KEYS[e.code];
        if (slot && opts.onSelectTimeframeShortcut) {
          opts.onSelectTimeframeShortcut(slot);
          e.preventDefault();
        }
        return;
      }

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
        default:
          // 1~9 → 0-based 탭 인덱스. 무제한 탭이어도 숫자 단축키는
          // 첫 9개 탭만 직접 선택한다. 그 이후 탭은 탭 목록/검색을 사용한다.
          // 정규식은 자기설명적이고 다중문자 key(예: 'F1')의 NaN 경로를 원천 차단.
          if (/^[1-9]$/.test(e.key) && opts.onSelectTabIndex) {
            opts.onSelectTabIndex(Number(e.key) - 1);
            e.preventDefault();
          }
          break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    opts.onNextCode,
    opts.onPrevCode,
    opts.onNextTab,
    opts.onPrevTab,
    opts.onSelectTabIndex,
    opts.onSelectTimeframeShortcut,
  ]);
}
